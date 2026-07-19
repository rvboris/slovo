use std::env;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use super::{BackendKind, ShortcutBackendStatus, ShortcutChord, ShortcutError};
use crate::{handle_hotkey_action, HotkeyEvent};
use slovo_shortcut_core::protocol::{
    decode_helper_line, encode_parent_line, read_bounded_line, EventState, HelperMessage,
    ParentCommand, PROTOCOL_VERSION,
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);

enum HelperRecord {
    Message(HelperMessage),
    Eof,
    Invalid,
}

fn read_helper_record<R: BufRead>(reader: &mut R) -> HelperRecord {
    let mut line = Vec::new();
    match read_bounded_line(reader, &mut line) {
        Ok(false) => HelperRecord::Eof,
        Ok(true) => decode_helper_line(&line)
            .map(HelperRecord::Message)
            .unwrap_or(HelperRecord::Invalid),
        Err(_) => HelperRecord::Invalid,
    }
}

#[derive(Debug, Default)]
struct EventFilter {
    generation: u64,
    last_seq: u64,
    pressed: bool,
}

impl EventFilter {
    fn configure(&mut self, generation: u64) {
        self.generation = generation;
        self.last_seq = 0;
    }

    fn accept(&mut self, generation: u64, seq: u64, state: EventState) -> Option<HotkeyEvent> {
        if generation != self.generation || seq <= self.last_seq {
            return None;
        }
        self.last_seq = seq;
        match state {
            EventState::Pressed if !self.pressed => {
                self.pressed = true;
                Some(HotkeyEvent::Pressed)
            }
            EventState::Released if self.pressed => {
                self.pressed = false;
                Some(HotkeyEvent::Released)
            }
            _ => None,
        }
    }

    fn release(&mut self) -> bool {
        std::mem::take(&mut self.pressed)
    }
}

pub struct WaylandSupervisor {
    child: Child,
    input: ChildStdin,
    messages: Receiver<Result<HelperMessage, String>>,
    filter: Arc<Mutex<EventFilter>>,
    app: AppHandle,
    next_id: u64,
    generation: u64,
    active: Option<ShortcutChord>,
    desired: Option<ShortcutChord>,
    status: Arc<Mutex<ShortcutBackendStatus>>,
    supervisor_generation: Arc<AtomicU64>,
    identity: u64,
    device_count: Option<usize>,
    reaped: bool,
}

impl WaylandSupervisor {
    pub fn spawn(app: AppHandle) -> Result<Self, ShortcutError> {
        Self::spawn_generation(app, Arc::new(AtomicU64::new(0)), 0)
    }

    fn spawn_generation(
        app: AppHandle,
        supervisor_generation: Arc<AtomicU64>,
        identity: u64,
    ) -> Result<Self, ShortcutError> {
        let path = resolve_helper_path().map_err(ShortcutError::Backend)?;
        log_wayland(&format!("spawning helper at {}", path.display()));
        let mut child = Command::new(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                ShortcutError::Backend(format!("cannot start helper {}: {error}", path.display()))
            })?;
        log_wayland(&format!("helper child pid {}", child.id()));
        let input = child
            .stdin
            .take()
            .ok_or_else(|| ShortcutError::Backend("helper stdin was not available".to_owned()))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| ShortcutError::Backend("helper stdout was not available".to_owned()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ShortcutError::Backend("helper stderr was not available".to_owned()))?;
        let (sender, messages) = mpsc::channel();
        let filter = Arc::new(Mutex::new(EventFilter::default()));
        let reader_filter = filter.clone();
        let status = Arc::new(Mutex::new(ShortcutBackendStatus::Starting {
            backend: BackendKind::WaylandHelper,
        }));
        let reader_status = status.clone();
        let reader_app = app.clone();
        let reader_generation = supervisor_generation.clone();
        thread::Builder::new()
            .name("slovo-helper-protocol".into())
            .spawn(move || {
                let mut reader = BufReader::new(output);
                loop {
                    match read_helper_record(&mut reader) {
                        HelperRecord::Eof => {
                            let detail = "helper closed protocol output".to_owned();
                            set_shared_status_if_current(
                                &reader_app,
                                &reader_status,
                                &reader_generation,
                                identity,
                                ShortcutBackendStatus::Failed {
                                    backend: BackendKind::WaylandHelper,
                                    detail: detail.clone(),
                                },
                            );
                            let _ = sender.send(Err(detail));
                            synthesize_release(&reader_app, &reader_filter);
                            break;
                        }
                        HelperRecord::Message(HelperMessage::Event {
                            generation,
                            seq,
                            state,
                        }) => {
                            let event = reader_filter
                                .lock()
                                .ok()
                                .and_then(|mut filter| filter.accept(generation, seq, state));
                            if evdev_debug_enabled() {
                                log_wayland(&format!(
                                    "received event generation={generation} seq={seq} state={state:?} accepted={}",
                                    event.is_some()
                                ));
                            }
                            if let Some(event) = event {
                                handle_hotkey_action(&reader_app, event);
                            }
                        }
                        HelperRecord::Message(message) => {
                            if sender.send(Ok(message)).is_err() {
                                break;
                            }
                        }
                        HelperRecord::Invalid => {
                            let detail = "helper emitted malformed protocol".to_owned();
                            set_shared_status_if_current(
                                &reader_app,
                                &reader_status,
                                &reader_generation,
                                identity,
                                ShortcutBackendStatus::Failed {
                                    backend: BackendKind::WaylandHelper,
                                    detail: detail.clone(),
                                },
                            );
                            let _ = sender.send(Err(detail));
                            synthesize_release(&reader_app, &reader_filter);
                            break;
                        }
                    }
                }
            })
            .map_err(|error| {
                ShortcutError::Backend(format!("cannot start helper reader: {error}"))
            })?;
        thread::Builder::new()
            .name("slovo-helper-stderr".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("[slovo-input-helper] {line}");
                }
            })
            .map_err(|error| {
                ShortcutError::Backend(format!("cannot drain helper stderr: {error}"))
            })?;

        let mut supervisor = Self {
            child,
            input,
            messages,
            filter,
            app,
            next_id: 1,
            generation: 0,
            active: None,
            desired: None,
            status,
            supervisor_generation,
            identity,
            device_count: None,
            reaped: false,
        };
        let id = supervisor.next_command_id();
        let hello = ParentCommand::Hello {
            id,
            protocol_version: PROTOCOL_VERSION,
            parent_pid: std::process::id(),
        };
        let hello_bytes = encode_parent_line(&hello)
            .map_err(|error| ShortcutError::Backend(format!("cannot encode hello: {error}")))?;
        log_wayland(&format!(
            "writing hello to helper stdin: {}",
            String::from_utf8_lossy(&hello_bytes).trim_end()
        ));
        supervisor
            .input
            .write_all(&hello_bytes)
            .and_then(|_| supervisor.input.flush())
            .map_err(|error| {
                ShortcutError::Backend(format!("cannot write hello to helper stdin: {error}"))
            })?;
        log_wayland("waiting for Ready from helper");
        let result = supervisor.wait_for(COMMAND_TIMEOUT, |message| {
            matches!(message, HelperMessage::Ready { reply_to, protocol, .. } if *reply_to == id && *protocol == PROTOCOL_VERSION)
        });
        match &result {
            Ok(HelperMessage::Ready { instance_id, .. }) => {
                log_wayland(&format!("helper ready, instance_id={instance_id}"));
            }
            Ok(other) => {
                log_wayland(&format!("helper returned unexpected message: {other:?}"));
            }
            Err(error) => {
                log_wayland(&format!("helper handshake failed: {error}"));
            }
        }
        match result? {
            HelperMessage::Ready { .. } => Ok(supervisor),
            _ => unreachable!(),
        }
    }

    pub fn status(&self) -> ShortcutBackendStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or(ShortcutBackendStatus::Failed {
                backend: BackendKind::WaylandHelper,
                detail: "shortcut status lock poisoned".into(),
            })
    }

    pub fn retry(&mut self) -> Result<(), ShortcutError> {
        if evdev_debug_enabled() {
            log_wayland(&format!("retry invoked, identity={}", self.identity));
        }
        let desired = self.desired.clone();
        self.set_status(ShortcutBackendStatus::Restarting {
            backend: BackendKind::WaylandHelper,
        });
        self.synthesize_release();
        let identity = self
            .identity
            .checked_add(1)
            .ok_or_else(|| ShortcutError::Backend("supervisor generation exhausted".to_owned()))?;
        let app = self.app.clone();
        let mut replacement =
            Self::spawn_generation(app, self.supervisor_generation.clone(), identity)?;
        // Transfer ownership before configuration can publish Active. From this
        // point onward the old reader cannot overwrite replacement status.
        self.supervisor_generation
            .store(identity, Ordering::Release);
        if let Some(chord) = desired {
            replacement.replace(chord)?;
        }
        std::mem::swap(self, &mut replacement);
        Ok(())
    }

    pub fn replace(&mut self, chord: ShortcutChord) -> Result<(), ShortcutError> {
        if evdev_debug_enabled() {
            log_wayland(&format!(
                "replace invoked chord={} active={:?} identity={}",
                chord, self.active, self.identity
            ));
        }
        if self.active.as_ref() == Some(&chord) {
            if evdev_debug_enabled() {
                log_wayland("replace: chord unchanged, returning Ok");
            }
            return Ok(());
        }
        self.desired = Some(chord.clone());
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| ShortcutError::Backend("helper generation exhausted".to_owned()))?;
        let generation = self.generation;
        let id = self.next_command_id();
        let release = self
            .filter
            .lock()
            .map(|mut filter| {
                let release = filter.release();
                filter.configure(generation);
                release
            })
            .unwrap_or(false);
        if release {
            handle_hotkey_action(&self.app, HotkeyEvent::Released);
        }
        if evdev_debug_enabled() {
            log_wayland(&format!("replace: sending configure gen={generation}"));
        }
        self.send(&ParentCommand::configure(id, generation, &chord))?;
        if evdev_debug_enabled() {
            log_wayland("replace: waiting for Configured ack");
        }
        let message = self.wait_for(COMMAND_TIMEOUT, |message| {
            matches!(message, HelperMessage::Configured { reply_to, generation: ack, .. } if *reply_to == id && *ack == generation)
        })?;
        if let HelperMessage::Configured { device_count, .. } = message {
            if evdev_debug_enabled() {
                log_wayland(&format!(
                    "replace: Configured ack device_count={device_count}"
                ));
            }
            self.device_count = Some(device_count);
            if device_count == 0 {
                let status = zero_device_status();
                self.set_status(status);
                self.synthesize_release();
                return Err(ShortcutError::Backend(
                    "helper configured without a readable keyboard".to_owned(),
                ));
            }
        }
        self.active = Some(chord.clone());
        self.set_status(ShortcutBackendStatus::Active {
            backend: BackendKind::WaylandHelper,
            shortcut: chord.to_string(),
            device_count: self.device_count,
        });
        Ok(())
    }

    pub fn shutdown(&mut self) -> Result<(), ShortcutError> {
        if self.reaped {
            return Ok(());
        }
        self.set_status(ShortcutBackendStatus::ShuttingDown);
        self.synthesize_release();
        let id = self.next_command_id();
        let result = self.send(&ParentCommand::Shutdown { id }).and_then(|_| {
            self.wait_for(
                SHUTDOWN_TIMEOUT,
                |message| matches!(message, HelperMessage::Bye { reply_to } if *reply_to == id),
            )
            .map(|_| ())
        });
        if result.is_err() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        self.reaped = true;
        self.active = None;
        self.desired = None;
        result
    }

    fn next_command_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }

    fn send(&mut self, command: &ParentCommand) -> Result<(), ShortcutError> {
        let line = encode_parent_line(command)
            .map_err(|error| ShortcutError::Backend(error.to_string()))?;
        self.input
            .write_all(&line)
            .and_then(|_| self.input.flush())
            .map_err(|error| self.fail(format!("cannot write helper command: {error}")))
    }

    fn wait_for<F>(&mut self, timeout: Duration, matches: F) -> Result<HelperMessage, ShortcutError>
    where
        F: Fn(&HelperMessage) -> bool,
    {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.messages.recv_timeout(remaining) {
                Ok(Ok(message)) if matches(&message) => return Ok(message),
                Ok(Ok(HelperMessage::Error { code, message, .. })) => {
                    let status = status_from_helper_error(&code);
                    let detail = format!("helper error {code}: {message}");
                    self.set_status(status);
                    self.synthesize_release();
                    return Err(ShortcutError::Backend(detail));
                }
                Ok(Ok(HelperMessage::Devices { device_count })) => {
                    self.device_count = Some(device_count);
                    if device_count == 0 {
                        self.set_status(ShortcutBackendStatus::DevicesUnavailable {
                            detail: "Нет доступных устройств клавиатуры.".to_owned(),
                        });
                    } else if let Some(chord) = self.active.as_ref() {
                        self.set_status(ShortcutBackendStatus::Active {
                            backend: BackendKind::WaylandHelper,
                            shortcut: chord.to_string(),
                            device_count: Some(device_count),
                        });
                    }
                }
                Ok(Ok(_)) => {}
                Ok(Err(error)) => return Err(self.fail(error)),
                Err(_) => return Err(self.fail("helper command timed out".into())),
            }
        }
    }

    fn fail(&mut self, message: String) -> ShortcutError {
        self.set_status(ShortcutBackendStatus::Failed {
            backend: BackendKind::WaylandHelper,
            detail: message.clone(),
        });
        self.synthesize_release();
        ShortcutError::Backend(message)
    }

    fn set_status(&self, status: ShortcutBackendStatus) {
        set_shared_status(&self.app, &self.status, status);
    }

    fn synthesize_release(&self) {
        synthesize_release(&self.app, &self.filter);
    }
}

impl Drop for WaylandSupervisor {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        log_wayland("Drop: killing helper child and synthesizing release");
        self.synthesize_release();
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.reaped = true;
    }
}

fn evdev_debug_enabled() -> bool {
    env::var_os("SLOVO_EVDEV_DEBUG").is_some_and(|value| value == "1")
}

fn log_wayland(message: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "[slovo] wayland supervisor: {message}");
    let _ = std::io::stderr().flush();
}

fn is_current_supervisor(generation: &AtomicU64, identity: u64) -> bool {
    generation.load(Ordering::Acquire) == identity
}

fn set_shared_status_if_current(
    app: &AppHandle,
    current: &Arc<Mutex<ShortcutBackendStatus>>,
    generation: &AtomicU64,
    identity: u64,
    status: ShortcutBackendStatus,
) {
    if is_current_supervisor(generation, identity) {
        set_shared_status(app, current, status);
    }
}

fn set_shared_status(
    app: &AppHandle,
    current: &Arc<Mutex<ShortcutBackendStatus>>,
    status: ShortcutBackendStatus,
) {
    if evdev_debug_enabled() {
        log_wayland(&format!("set_shared_status publishing {status:?}"));
    }
    if let Ok(mut value) = current.lock() {
        *value = status.clone();
    }
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Ok(mut value) = state.shortcut_status.lock() {
            *value = status.clone();
        }
    }
    let _ = app.emit("slovo://shortcut-status", status);
}

fn zero_device_status() -> ShortcutBackendStatus {
    ShortcutBackendStatus::PermissionDenied {
        detail: "Нет доступных для чтения устройств клавиатуры. Проверьте разрешения доступа."
            .to_owned(),
        setup_available: true,
    }
}

fn status_from_helper_error(code: &str) -> ShortcutBackendStatus {
    match code {
        "permission-denied" => ShortcutBackendStatus::PermissionDenied {
            detail: "Нет доступа к устройствам клавиатуры.".to_owned(),
            setup_available: true,
        },
        "no-keyboards" => ShortcutBackendStatus::DevicesUnavailable {
            detail: "Клавиатура не найдена.".to_owned(),
        },
        "no-readable-keyboards" => ShortcutBackendStatus::DevicesUnavailable {
            detail: "Нет доступных устройств клавиатуры.".to_owned(),
        },
        _ => ShortcutBackendStatus::Failed {
            backend: BackendKind::WaylandHelper,
            detail: "Служба горячих клавиш недоступна.".to_owned(),
        },
    }
}

fn synthesize_release(app: &AppHandle, filter: &Arc<Mutex<EventFilter>>) {
    let release = filter
        .lock()
        .map(|mut state| state.release())
        .unwrap_or(false);
    if release {
        handle_hotkey_action(app, HotkeyEvent::Released);
    }
}

pub fn resolve_helper_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("SLOVO_INPUT_HELPER") {
        let path = PathBuf::from(path);
        return validate_helper(path, "SLOVO_INPUT_HELPER");
    }
    let current =
        env::current_exe().map_err(|error| format!("cannot locate current executable: {error}"))?;
    let mut candidates = Vec::new();
    if let Some(parent) = current.parent() {
        candidates.push(parent.join("slovo-input-helper"));
        if parent.file_name().is_some_and(|name| name == "deps") {
            if let Some(debug) = parent.parent() {
                candidates.push(debug.join("slovo-input-helper"));
            }
        }
    }
    if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
        return Ok(path);
    }
    Err("slovo-input-helper was not found; build it or set SLOVO_INPUT_HELPER to its executable path".into())
}

fn validate_helper(path: PathBuf, source: &str) -> Result<PathBuf, String> {
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "{source} points to missing helper {}",
            path.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::mpsc::RecvTimeoutError;

    use slovo_shortcut_core::protocol::{
        decode_parent_line, encode_helper_line, HelperMessage, ParentCommand, MAX_LINE_BYTES,
    };

    #[derive(Default)]
    struct LifecycleHarness {
        filter: EventFilter,
        dispatched: Vec<HotkeyEvent>,
        failed: bool,
        synthetic_releases: usize,
        reaped: bool,
    }

    impl LifecycleHarness {
        fn configure(&mut self, generation: u64) {
            self.filter = EventFilter::default();
            self.filter.configure(generation);
        }

        fn process(&mut self, record: HelperRecord) -> Option<HelperMessage> {
            match record {
                HelperRecord::Message(HelperMessage::Event {
                    generation,
                    seq,
                    state,
                }) => {
                    if let Some(event) = self.filter.accept(generation, seq, state) {
                        self.dispatched.push(event);
                    }
                    None
                }
                HelperRecord::Message(message) => Some(message),
                HelperRecord::Eof | HelperRecord::Invalid => {
                    self.failed = true;
                    self.synthesize_release();
                    None
                }
            }
        }

        fn synthesize_release(&mut self) {
            if self.filter.release() {
                self.synthetic_releases += 1;
                self.dispatched.push(HotkeyEvent::Released);
            }
        }

        fn reap(&mut self) -> bool {
            !std::mem::replace(&mut self.reaped, true)
        }
    }

    fn record(message: &HelperMessage) -> HelperRecord {
        let bytes = encode_helper_line(message).unwrap();
        read_helper_record(&mut Cursor::new(bytes))
    }

    #[test]
    fn transport_handshake_and_configure_ack_round_trip() {
        let hello = ParentCommand::Hello {
            id: 1,
            protocol_version: PROTOCOL_VERSION,
            parent_pid: 42,
        };
        let encoded = encode_parent_line(&hello).unwrap();
        assert_eq!(decode_parent_line(&encoded).unwrap(), hello);

        let mut harness = LifecycleHarness::default();
        assert!(matches!(
            harness.process(record(&HelperMessage::Ready {
                reply_to: 1,
                protocol: PROTOCOL_VERSION,
                instance_id: "fixture".into(),
            })),
            Some(HelperMessage::Ready { reply_to: 1, .. })
        ));
        harness.configure(7);
        assert!(matches!(
            harness.process(record(&HelperMessage::Configured {
                reply_to: 2,
                generation: 7,
                device_count: 2,
            })),
            Some(HelperMessage::Configured {
                reply_to: 2,
                generation: 7,
                device_count: 2
            })
        ));
    }

    #[test]
    fn decoded_transport_events_dispatch_once_and_suppress_stale_sequences() {
        let mut harness = LifecycleHarness::default();
        harness.configure(9);
        for (generation, seq, state) in [
            (8, 1, EventState::Pressed),
            (9, 1, EventState::Pressed),
            (9, 1, EventState::Released),
            (9, 2, EventState::Pressed),
            (9, 3, EventState::Released),
            (9, 2, EventState::Released),
        ] {
            harness.process(record(&HelperMessage::Event {
                generation,
                seq,
                state,
            }));
        }
        assert_eq!(
            harness.dispatched,
            [HotkeyEvent::Pressed, HotkeyEvent::Released]
        );
    }

    #[test]
    fn malformed_and_oversized_transport_fail_with_bounded_storage() {
        let mut malformed = Cursor::new(b"not-json\n".to_vec());
        assert!(matches!(
            read_helper_record(&mut malformed),
            HelperRecord::Invalid
        ));

        let mut oversized = Cursor::new(vec![b'x'; MAX_LINE_BYTES * 8]);
        assert!(matches!(
            read_helper_record(&mut oversized),
            HelperRecord::Invalid
        ));
        assert_eq!(oversized.position(), (MAX_LINE_BYTES * 8) as u64);

        let mut harness = LifecycleHarness::default();
        harness.process(HelperRecord::Invalid);
        assert!(harness.failed);
    }

    #[test]
    fn eof_while_pressed_synthesizes_exactly_one_release() {
        let mut harness = LifecycleHarness::default();
        harness.configure(3);
        harness.process(record(&HelperMessage::Event {
            generation: 3,
            seq: 1,
            state: EventState::Pressed,
        }));
        harness.process(HelperRecord::Eof);
        harness.process(HelperRecord::Eof);
        assert_eq!(harness.synthetic_releases, 1);
        assert_eq!(
            harness.dispatched,
            [HotkeyEvent::Pressed, HotkeyEvent::Released]
        );
    }

    #[test]
    fn graceful_shutdown_bye_and_reap_are_idempotent() {
        let shutdown = ParentCommand::Shutdown { id: 11 };
        let encoded = encode_parent_line(&shutdown).unwrap();
        assert_eq!(decode_parent_line(&encoded).unwrap(), shutdown);
        let mut harness = LifecycleHarness::default();
        assert!(matches!(
            harness.process(record(&HelperMessage::Bye { reply_to: 11 })),
            Some(HelperMessage::Bye { reply_to: 11 })
        ));
        assert!(harness.reap());
        assert!(!harness.reap());
    }

    #[test]
    fn retry_resets_filter_and_accepts_sequence_one_again() {
        let mut harness = LifecycleHarness::default();
        harness.configure(4);
        harness.process(record(&HelperMessage::Event {
            generation: 4,
            seq: 20,
            state: EventState::Pressed,
        }));
        harness.synthesize_release();
        harness.configure(1);
        harness.process(record(&HelperMessage::Event {
            generation: 1,
            seq: 1,
            state: EventState::Pressed,
        }));
        assert_eq!(
            harness.dispatched,
            [
                HotkeyEvent::Pressed,
                HotkeyEvent::Released,
                HotkeyEvent::Pressed
            ]
        );
    }

    #[test]
    fn command_timeout_is_bounded_and_test_configurable() {
        let (_sender, receiver) = mpsc::channel::<HelperMessage>();
        let started = Instant::now();
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(5)),
            Err(RecvTimeoutError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn event_filter_suppresses_stale_duplicates_and_out_of_order_events() {
        let mut filter = EventFilter::default();
        filter.configure(4);
        assert_eq!(filter.accept(3, 1, EventState::Pressed), None);
        assert_eq!(
            filter.accept(4, 2, EventState::Pressed),
            Some(HotkeyEvent::Pressed)
        );
        assert_eq!(filter.accept(4, 2, EventState::Released), None);
        assert_eq!(filter.accept(4, 3, EventState::Pressed), None);
        assert_eq!(
            filter.accept(4, 4, EventState::Released),
            Some(HotkeyEvent::Released)
        );
        assert_eq!(filter.accept(4, 5, EventState::Released), None);
    }

    #[test]
    fn stale_reader_generation_cannot_publish_failure() {
        let generation = AtomicU64::new(2);
        assert!(!is_current_supervisor(&generation, 1));
        assert!(is_current_supervisor(&generation, 2));
    }

    #[test]
    fn zero_configured_devices_is_actionable_permission_failure() {
        assert!(matches!(
            zero_device_status(),
            ShortcutBackendStatus::PermissionDenied {
                setup_available: true,
                ..
            }
        ));
    }

    #[test]
    fn helper_error_codes_map_to_public_statuses() {
        assert!(matches!(
            status_from_helper_error("permission-denied"),
            ShortcutBackendStatus::PermissionDenied {
                setup_available: true,
                ..
            }
        ));
        assert!(matches!(
            status_from_helper_error("no-keyboards"),
            ShortcutBackendStatus::DevicesUnavailable { .. }
        ));
        assert!(matches!(
            status_from_helper_error("internal"),
            ShortcutBackendStatus::Failed {
                backend: BackendKind::WaylandHelper,
                ..
            }
        ));
    }

    #[test]
    fn explicit_missing_helper_is_actionable() {
        let error = validate_helper(
            PathBuf::from("/definitely/missing/slovo-input-helper"),
            "test",
        )
        .unwrap_err();
        assert!(error.contains("test"));
        assert!(error.contains("missing"));
    }
}
