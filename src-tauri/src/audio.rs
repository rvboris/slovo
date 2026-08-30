use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use num_traits::cast;
use std::io::Cursor;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const TARGET_RATE: u32 = 16_000;
const MAX_DURATION: Duration = Duration::from_mins(2);
const VAD_MIN_RECORDING: Duration = Duration::from_millis(400);
const VAD_SILENCE: Duration = Duration::from_millis(900);
const VAD_THRESHOLD_MULTIPLIER: f32 = 3.0;
const VAD_MIN_THRESHOLD: f32 = 0.012;

/// RMS at which the normalized level saturates to 1.0. Chosen just above the
/// speech range the VAD already reacts to (`VAD_MIN_THRESHOLD * a few x`): a
/// normal speaking voice lands in the upper half of the bar, background noise
/// stays near the bottom.
const LEVEL_FULL_SCALE_RMS: f32 = 0.08;

type StopCallback = Box<dyn Fn() + Send + Sync + 'static>;

enum Command {
    Start {
        auto_vad: bool,
        device_name: Option<String>,
        on_auto_stop: StopCallback,
        // Replies with the cpal device name that was actually opened (which may
        // differ from the configured setting, e.g. when it resolves to the
        // system default), so callers can surface it to the user.
        reply: mpsc::Sender<Result<String, String>>,
    },
    Stop {
        reply: mpsc::Sender<Result<Vec<u8>, String>>,
    },
}

struct ActiveRecording {
    stream: Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
}

impl Drop for ActiveRecording {
    fn drop(&mut self) {
        // Pausing (rather than dropping) is the cpal-recommended way to release
        // the microphone cleanly: the underlying stream handle may be moved
        // out before Drop runs (see Command::Stop), and pause() is idempotent.
        let _ = self.stream.pause();
    }
}

#[derive(Clone)]
pub struct AudioController {
    commands: mpsc::Sender<Command>,
    // Live microphone level as f32 RMS bits (0.0 when idle). Updated from the
    // capture callback, read by the recording overlay poller. Reset to silence
    // whenever a recording starts or stops so a stale value never leaks out.
    level: Arc<AtomicU32>,
}

impl AudioController {
    pub fn new() -> Self {
        let (commands, receiver) = mpsc::channel();
        let level = Arc::new(AtomicU32::new(0));
        let worker_level = Arc::clone(&level);
        std::thread::spawn(move || {
            let mut active: Option<ActiveRecording> = None;
            while let Ok(command) = receiver.recv() {
                match command {
                    Command::Start {
                        auto_vad,
                        device_name,
                        on_auto_stop,
                        reply,
                    } => {
                        let result = if active.is_some() {
                            Err("recording is already active".into())
                        } else {
                            worker_level.store(0, Ordering::Relaxed);
                            open_stream(
                                auto_vad,
                                device_name.as_deref(),
                                on_auto_stop,
                                &worker_level,
                            )
                            .map(|(recording, opened_name)| {
                                active = Some(recording);
                                opened_name
                            })
                        };
                        let _ = reply.send(result);
                    }
                    Command::Stop { reply } => {
                        worker_level.store(0, Ordering::Relaxed);
                        let result = active
                            .take()
                            .ok_or_else(|| "no active recording".into())
                            .and_then(|recording| {
                                // Pull the buffered samples and sample rate out
                                // before dropping the recording: Drop pauses
                                // the stream so no further samples arrive,
                                // then we resample what was captured.
                                let sample_rate = recording.sample_rate;
                                let samples = recording
                                    .samples
                                    .lock()
                                    .map_err(|_| "microphone buffer lock poisoned")?
                                    .clone();
                                drop(recording);
                                wav_bytes(
                                    &resample_linear(&samples, sample_rate, TARGET_RATE),
                                    TARGET_RATE,
                                )
                            });
                        let _ = reply.send(result);
                    }
                }
            }
        });
        Self { commands, level }
    }

    /// Starts capture and returns the cpal name of the device that was actually
    /// opened. When `device_name` is `None`/empty this is the system default
    /// input, so callers can show the user which microphone is live.
    pub fn start(
        &self,
        auto_vad: bool,
        device_name: Option<String>,
        on_auto_stop: StopCallback,
    ) -> Result<String, String> {
        let (reply, receiver) = mpsc::channel();
        self.commands
            .send(Command::Start {
                auto_vad,
                device_name,
                on_auto_stop,
                reply,
            })
            .map_err(|_| "audio worker stopped")?;
        receiver.recv().map_err(|_| "audio worker stopped")?
    }

    pub fn stop(&self) -> Result<Vec<u8>, String> {
        let (reply, receiver) = mpsc::channel();
        self.commands
            .send(Command::Stop { reply })
            .map_err(|_| "audio worker stopped")?;
        receiver.recv().map_err(|_| "audio worker stopped")?
    }

    /// Normalized live microphone level in `0.0..=1.0`, or `0.0` when not
    /// recording. Cheap lock-free read; safe to poll from the UI thread.
    pub fn level(&self) -> f32 {
        let bits = self.level.load(Ordering::Relaxed);
        if bits == 0 {
            return 0.0;
        }
        normalize_level(f32::from_bits(bits))
    }
}

fn open_stream(
    auto_vad: bool,
    device_name: Option<&str>,
    on_auto_stop: StopCallback,
    level: &Arc<AtomicU32>,
) -> Result<(ActiveRecording, String), String> {
    let host = cpal::default_host();
    let device = match device_name.map(str::trim) {
        Some(name) if !name.is_empty() => select_device_by_name(&host, name)?,
        _ => host
            .default_input_device()
            .ok_or("no default microphone available")?,
    };
    // Capture the cpal device name now, before `device` is moved into
    // `build_input_stream`. This is the real microphone that got opened, which
    // the configured setting may only approximate (or resolve to the default).
    let opened_name = device
        .name()
        .map(|name| name.trim().to_owned())
        .unwrap_or_default();
    let supported = device
        .default_input_config()
        .map_err(|error| format!("cannot read microphone config: {error}"))?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let config: StreamConfig = supported.clone().into();
    let samples = Arc::new(Mutex::new(Vec::new()));
    let started = Instant::now();
    let vad = Arc::new(Mutex::new(Vad::new(started)));
    let stop_once = Arc::new(Mutex::new(false));
    let error_callback = |error| eprintln!("microphone stream error: {error}");

    macro_rules! build_stream {
        ($type:ty, $convert:expr) => {{
            let samples = Arc::clone(&samples);
            let vad = Arc::clone(&vad);
            let stop_once = Arc::clone(&stop_once);
            let level = Arc::clone(&level);
            device.build_input_stream(
                &config,
                move |data: &[$type], _| {
                    let mono = interleaved_to_mono(data, channels, $convert);
                    if let Ok(mut target) = samples.lock() {
                        target.extend_from_slice(&mono);
                    }
                    level.store(rms(&mono).to_bits(), Ordering::Relaxed);
                    let should_stop = started.elapsed() >= MAX_DURATION
                        || (auto_vad && vad.lock().map(|mut v| v.observe(&mono)).unwrap_or(false));
                    if should_stop {
                        if let Ok(mut fired) = stop_once.lock() {
                            if !*fired {
                                *fired = true;
                                on_auto_stop();
                            }
                        }
                    }
                },
                error_callback,
                None,
            )
        }};
    }

    let stream = match supported.sample_format() {
        SampleFormat::F32 => build_stream!(f32, |sample: f32| sample),
        SampleFormat::I16 => {
            build_stream!(i16, |sample: i16| f32::from(sample) / f32::from(i16::MAX))
        }
        SampleFormat::U16 => build_stream!(u16, |sample: u16| {
            (f32::from(sample) / f32::from(u16::MAX)).mul_add(2.0, -1.0)
        }),
        format => return Err(format!("unsupported microphone sample format: {format:?}")),
    }
    .map_err(|error| format!("cannot open microphone: {error}"))?;
    stream
        .play()
        .map_err(|error| format!("cannot start microphone: {error}"))?;
    Ok((
        ActiveRecording {
            stream,
            samples,
            sample_rate,
        },
        opened_name,
    ))
}

fn select_device_by_name(host: &cpal::Host, wanted: &str) -> Result<cpal::Device, String> {
    let devices = host
        .input_devices()
        .map_err(|error| format!("cannot enumerate input devices: {error}"))?;
    let mut fallback: Option<cpal::Device> = None;
    for device in devices {
        let Ok(name) = device.name() else {
            continue;
        };
        if name.trim() == wanted {
            return Ok(device);
        }
        if fallback.is_none() && name.trim().contains(wanted) {
            fallback = Some(device);
        }
    }
    fallback.ok_or_else(|| format!("input device not found: {wanted}"))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub name: String,
    pub is_default: bool,
}

fn is_obvious_non_microphone_capture_endpoint(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    name.starts_with("monitor of ")
        || name.ends_with(" monitor")
        || name.contains(".monitor")
        || name
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|part| part == "loopback")
}

pub fn list_input_devices() -> Result<Vec<InputDevice>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.name().ok())
        .map(|name| name.trim().to_owned());
    let mut devices = host
        .input_devices()
        .map_err(|error| format!("cannot enumerate input devices: {error}"))?
        .filter_map(|device| {
            if device.default_input_config().is_err() {
                return None;
            }
            device
                .name()
                .ok()
                .map(|name| name.trim().to_owned())
                .filter(|name| !name.is_empty())
                .filter(|name| {
                    !cfg!(target_os = "linux") || !is_obvious_non_microphone_capture_endpoint(name)
                })
                .map(|name| InputDevice {
                    is_default: default_name.as_deref() == Some(name.as_str()),
                    name,
                })
        })
        .collect::<Vec<_>>();
    devices.sort_by(|a, b| match (a.is_default, b.is_default) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    devices.dedup_by(|a, b| a.name == b.name);
    Ok(devices)
}

struct Vad {
    started: Instant,
    noise_rms: f32,
    speech_seen: bool,
    silence_since: Option<Instant>,
}

impl Vad {
    fn new(started: Instant) -> Self {
        Self {
            started,
            noise_rms: 0.005,
            speech_seen: false,
            silence_since: None,
        }
    }

    fn observe(&mut self, samples: &[f32]) -> bool {
        if samples.is_empty() {
            return false;
        }
        let (sum_squares, sample_count) = samples
            .iter()
            .fold((0.0_f32, 0.0_f32), |(sum, count), value| {
                (value.mul_add(*value, sum), count + 1.0)
            });
        let rms = (sum_squares / sample_count).sqrt();
        if !self.speech_seen {
            self.noise_rms = rms.mul_add(0.02, self.noise_rms * 0.98);
        }
        let speech = rms > (self.noise_rms * VAD_THRESHOLD_MULTIPLIER).max(VAD_MIN_THRESHOLD);
        if speech {
            self.speech_seen = true;
            self.silence_since = None;
        } else if self.speech_seen {
            self.silence_since.get_or_insert_with(Instant::now);
        }
        self.started.elapsed() >= VAD_MIN_RECORDING
            && self.speech_seen
            && self
                .silence_since
                .is_some_and(|at| at.elapsed() >= VAD_SILENCE)
    }
}

/// Root-mean-square of a mono buffer, 0 for empty input. Mirrors the energy
/// estimate the VAD already computes.
fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let (sum_squares, count) = samples
        .iter()
        .fold((0.0_f32, 0.0_f32), |(sum, count), value| {
            (value.mul_add(*value, sum), count + 1.0)
        });
    (sum_squares / count).sqrt()
}

/// Map an RMS level to a `0.0..=1.0` bar height. Linear RMS would leave the bar
/// parked near the bottom for normal speech, so we apply a gentle sqrt curve
/// and saturate at [`LEVEL_FULL_SCALE_RMS`]; the ceiling sits just above the
/// speech range the VAD reacts to, so background noise reads low and a clear
/// voice fills the bar without pegging on quiet talk.
fn normalize_level(rms: f32) -> f32 {
    if !rms.is_finite() || rms <= 0.0 {
        return 0.0;
    }
    (rms / LEVEL_FULL_SCALE_RMS).sqrt().clamp(0.0, 1.0)
}

pub fn interleaved_to_mono<T: Copy>(
    input: &[T],
    channels: usize,
    convert: impl Fn(T) -> f32,
) -> Vec<f32> {
    if channels == 0 {
        return Vec::new();
    }
    input
        .chunks_exact(channels)
        .map(|frame| {
            let (sum, count) = frame
                .iter()
                .copied()
                .map(&convert)
                .fold((0.0_f32, 0.0_f32), |(sum, count), value| {
                    (sum + value, count + 1.0)
                });
            sum / count
        })
        .collect()
}

pub fn resample_linear(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if input.is_empty() || source_rate == 0 || target_rate == 0 {
        return Vec::new();
    }
    if source_rate == target_rate {
        return input.to_vec();
    }
    let Ok(target_rate_usize) = usize::try_from(target_rate) else {
        return Vec::new();
    };
    let Ok(source_rate_usize) = usize::try_from(source_rate) else {
        return Vec::new();
    };
    let Some(output_len) = input
        .len()
        .checked_mul(target_rate_usize)
        .map(|scaled| scaled / source_rate_usize)
    else {
        return Vec::new();
    };
    let source_rate = f64::from(source_rate);
    let target_rate = f64::from(target_rate);
    (0..output_len)
        .map(|index| {
            let source_pos =
                cast::<usize, f64>(index).unwrap_or(f64::MAX) * source_rate / target_rate;
            let left = cast::<f64, usize>(source_pos.floor())
                .unwrap_or(input.len() - 1)
                .min(input.len() - 1);
            let right = left.saturating_add(1).min(input.len() - 1);
            let left_position = cast::<usize, f64>(left).unwrap_or(source_pos);
            let fraction = cast::<f64, f32>(source_pos - left_position).unwrap_or_default();
            (input[right] - input[left]).mul_add(fraction, input[left])
        })
        .collect()
}

pub fn wav_bytes(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    let mut cursor = Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
    for sample in samples {
        let scaled = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round();
        let value = cast::<f32, i16>(scaled).unwrap_or_else(|| {
            if scaled.is_sign_negative() {
                i16::MIN
            } else {
                i16::MAX
            }
        });
        writer.write_sample(value).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_obvious_non_microphone_capture_endpoints() {
        for name in [
            "Monitor of Built-in Audio Analog Stereo",
            "Built-in Audio Analog Stereo Monitor",
            "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor",
            "Loopback",
            "Loopback PCM",
        ] {
            assert!(
                is_obvious_non_microphone_capture_endpoint(name),
                "expected {name:?} to be excluded"
            );
        }
    }

    #[test]
    fn preserves_possible_microphone_endpoints() {
        for name in [
            "Unknown",
            "default",
            "sysdefault",
            "USB Audio Device",
            "Bluetooth Headset Microphone",
            "Monitor Audio USB Microphone",
        ] {
            assert!(
                !is_obvious_non_microphone_capture_endpoint(name),
                "expected {name:?} to be preserved"
            );
        }
    }

    #[test]
    fn mixes_stereo_to_mono() {
        assert_eq!(
            interleaved_to_mono(&[1.0, -1.0, 0.5, 0.5], 2, |v| v),
            vec![0.0, 0.5]
        );
    }

    #[test]
    fn resamples_linearly() {
        assert_eq!(resample_linear(&[0.0, 1.0], 2, 4), vec![0.0, 0.5, 1.0, 1.0]);
        assert_eq!(resample_linear(&[0.2, 0.4], 16_000, 16_000), vec![0.2, 0.4]);
    }

    #[test]
    fn normalizes_level_into_unit_range() {
        // Silence / invalid inputs collapse to zero.
        assert!(normalize_level(0.0).abs() < f32::EPSILON);
        assert!(normalize_level(-1.0).abs() < f32::EPSILON);
        assert!(normalize_level(f32::NAN).abs() < f32::EPSILON);
        // The full-scale ceiling saturates to 1.0 and never exceeds it.
        assert!((normalize_level(LEVEL_FULL_SCALE_RMS) - 1.0).abs() < 1e-6);
        assert!((normalize_level(LEVEL_FULL_SCALE_RMS * 4.0) - 1.0).abs() < f32::EPSILON);
        // Quiet background noise (just under the VAD floor) reads low but
        // non-zero, loud speech (a few times the floor) lands high.
        assert!(normalize_level(VAD_MIN_THRESHOLD) < 0.45);
        assert!(normalize_level(VAD_MIN_THRESHOLD * 4.0) > 0.5);
    }

    #[test]
    fn writes_valid_mono_wav() {
        let bytes = wav_bytes(&[-1.0, 0.0, 1.0], 16_000).unwrap();
        let reader = hound::WavReader::new(Cursor::new(bytes)).unwrap();
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, 16_000);
        assert_eq!(reader.len(), 3);
    }
}
