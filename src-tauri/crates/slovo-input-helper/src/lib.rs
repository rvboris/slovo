//! Linux-only evdev helper; the whole crate compiles to nothing elsewhere.
#![cfg(target_os = "linux")]

use std::io::{self, Write};
use std::sync::mpsc;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use slovo_shortcut_core::chord::ShortcutChord;
use slovo_shortcut_core::matcher::{ChordSpec, MatchEvent, MatchState, Matcher};
use slovo_shortcut_core::protocol::{
    decode_parent_line, encode_helper_line, read_bounded_line, EventState, HelperMessage,
    ParentCommand, ProtocolError, MAX_LINE_BYTES, PROTOCOL_VERSION,
};

mod device_loop;

use device_loop::{DeviceLoop, ScanSummary};

pub(crate) fn evdev_debug_enabled() -> bool {
    std::env::var_os("SLOVO_EVDEV_DEBUG").is_some_and(|value| value == "1")
}

pub fn run() -> Result<(), String> {
    harden_process()?;
    let parent_pid = unsafe { libc::getppid() };
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("slovo-helper-stdin".into())
        .spawn(move || read_commands(&sender))
        .map_err(|error| format!("cannot start command reader: {error}"))?;

    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut devices = DeviceLoop::new().map_err(|error| error.to_string())?;
    let mut state = CommandState::new(instance_id());
    let (initial, initial_events) = devices.rescan(&mut state.matcher);
    debug_assert!(initial_events.is_empty());
    report_scan_diagnostic(&initial);

    loop {
        // Parent-death detection: if the parent has been reparented to init
        // (pid 1) we exit cleanly.  Stdin EOF remains the primary cooperative
        // shutdown signal; this poll is the backup.
        if unsafe { libc::getppid() } != parent_pid {
            return Ok(());
        }
        let mut pending = Vec::new();
        if let Err(error) = devices.poll_once(&mut state.matcher, |event| {
            pending.push(event);
            Ok(())
        }) {
            eprintln!("[slovo-input-helper] device loop error: {error}");
            emit(
                &mut output,
                &HelperMessage::Error {
                    reply_to: None,
                    code: "device-error".into(),
                    message: "input device processing failed".into(),
                    retryable: true,
                },
            )?;
            let (summary, events) = devices.rescan(&mut state.matcher);
            pending.extend(events);
            report_scan_diagnostic(&summary);
        }
        for event in pending {
            state.emit_event(event, &mut output)?;
        }
        while let Ok(input) = receiver.try_recv() {
            match input {
                ReaderMessage::Command(command) => {
                    if state.handle(command, &mut devices, &mut output)? {
                        return Ok(());
                    }
                }
                ReaderMessage::Invalid(error) => emit(
                    &mut output,
                    &HelperMessage::Error {
                        reply_to: None,
                        code: "invalid-command".into(),
                        message: error,
                        retryable: true,
                    },
                )?,
                ReaderMessage::Closed => return Ok(()),
            }
        }
    }
}

// Raw evdev events stay in this helper rather than the WebView/main event path.
// This is an isolation boundary for accidental exposure, not a privilege boundary
// against another process already running as the same user.
//
// Lifetime is guarded by two complementary mechanisms:
//   1. Stdin EOF (primary): the parent closes stdin, and the command reader
//      thread sends `ReaderMessage::Closed`, which terminates the main loop.
//   2. getppid() poll (backup): the main loop checks whether the parent has
//      been reparented to init (pid 1) and exits cleanly. This covers the case
//      where the parent crashes without closing stdin explicitly.
//
// A kernel parent-death signal is deliberately NOT used. The helper may be
// spawned from a temporary thread (e.g. `slovo-shortcut-retry`), and on Linux
// that signal fires on the death of the *creating thread*, not the process.
// When that short-lived thread exits, the kernel delivers the signal and kills
// the helper seconds after it starts. The combination of stdin EOF and getppid
// polling already provides reliable lifetime tracking without this pitfall.
//
// PR_SET_NO_NEW_PRIVS is retained: it is a one-way security hardening flag
// that prevents privilege escalation and has no interaction with thread
// lifetime.
fn harden_process() -> Result<(), String> {
    unsafe {
        if libc::prctl(
            libc::PR_SET_NO_NEW_PRIVS,
            libc::c_ulong::from(1u32),
            0,
            0,
            0,
        ) != 0
        {
            return Err(format!(
                "cannot set no-new-privileges: {}",
                io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

fn instance_id() -> String {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{nonce:x}", std::process::id())
}

enum ReaderMessage {
    Command(ParentCommand),
    Invalid(String),
    Closed,
}

fn read_commands(sender: &mpsc::Sender<ReaderMessage>) {
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    loop {
        let mut line = Vec::new();
        match read_bounded_line(&mut reader, &mut line) {
            Ok(false) => {
                let _ = sender.send(ReaderMessage::Closed);
                return;
            }
            Ok(true) if line.len() > MAX_LINE_BYTES => {
                let _ = sender.send(ReaderMessage::Invalid(format!(
                    "protocol line exceeds {MAX_LINE_BYTES} bytes"
                )));
            }
            Ok(true) => {
                let message = match decode_parent_line(&line) {
                    Ok(command) => ReaderMessage::Command(command),
                    Err(error) => ReaderMessage::Invalid(safe_protocol_error(&error)),
                };
                if sender.send(message).is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = sender.send(ReaderMessage::Invalid(format!(
                    "cannot read command: {error}"
                )));
                return;
            }
        }
    }
}

fn safe_protocol_error(error: &ProtocolError) -> String {
    match error {
        ProtocolError::UnsupportedVersion(_) => "unsupported protocol version".into(),
        ProtocolError::Oversized { .. } => "protocol line is oversized".into(),
        ProtocolError::Empty => "protocol line is empty".into(),
        ProtocolError::InvalidFraming => "protocol line has invalid framing".into(),
        ProtocolError::Malformed(_) => "protocol command is malformed".into(),
    }
}

struct CommandState {
    matcher: Matcher,
    instance_id: String,
    seq: u64,
}

impl CommandState {
    fn new(instance_id: String) -> Self {
        Self {
            matcher: Matcher::new(),
            instance_id,
            seq: 0,
        }
    }

    fn handle<W: Write>(
        &mut self,
        command: ParentCommand,
        devices: &mut DeviceLoop,
        output: &mut W,
    ) -> Result<bool, String> {
        match command {
            ParentCommand::Hello {
                id,
                protocol_version,
                ..
            } => {
                if protocol_version != PROTOCOL_VERSION {
                    return Self::error(
                        output,
                        Some(id),
                        "invalid-command",
                        "unsupported protocol version",
                        false,
                    )
                    .map(|()| false);
                }
                emit(
                    output,
                    &HelperMessage::Ready {
                        reply_to: id,
                        protocol: PROTOCOL_VERSION,
                        instance_id: self.instance_id.clone(),
                    },
                )?;
            }
            ParentCommand::Configure {
                id,
                generation,
                chord,
            } => {
                self.configure(id, generation, &chord, devices.device_count(), output)?;
            }
            ParentCommand::Rescan { id } => {
                let (summary, events) = devices.rescan(&mut self.matcher);
                for event in events {
                    self.emit_event(event, output)?;
                }
                report_scan_diagnostic(&summary);
                if summary.readable == 0 {
                    let (code, message) = summary_error(&summary);
                    Self::error(output, Some(id), code, message, true)?;
                }
                emit(
                    output,
                    &HelperMessage::Devices {
                        device_count: summary.readable,
                    },
                )?;
            }
            ParentCommand::Shutdown { id } => {
                if let Some(event) = self.matcher.shutdown() {
                    self.emit_event(event, output)?;
                }
                emit(output, &HelperMessage::Bye { reply_to: id })?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn configure<W: Write>(
        &mut self,
        id: u64,
        generation: u64,
        chord: &str,
        device_count: usize,
        output: &mut W,
    ) -> Result<(), String> {
        let Ok(chord) = chord.parse::<ShortcutChord>() else {
            return Self::error(
                output,
                Some(id),
                "invalid-command",
                "invalid shortcut chord",
                true,
            );
        };
        if evdev_debug_enabled() {
            eprintln!(
                "[slovo-input-helper] configured chord={chord} generation={generation} device_count={device_count}"
            );
        }
        if let Some(event) = self.matcher.configure(generation, ChordSpec::from(chord)) {
            self.emit_event(event, output)?;
        }
        emit(
            output,
            &HelperMessage::Configured {
                reply_to: id,
                generation,
                device_count,
            },
        )
    }

    fn emit_event<W: Write>(&mut self, event: MatchEvent, output: &mut W) -> Result<(), String> {
        if evdev_debug_enabled() {
            eprintln!(
                "[slovo-input-helper] protocol event generation={} state={:?}",
                event.generation, event.state
            );
        }
        self.seq = self
            .seq
            .checked_add(1)
            .ok_or_else(|| "event sequence exhausted".to_owned())?;
        emit(
            output,
            &HelperMessage::Event {
                generation: event.generation,
                seq: self.seq,
                state: match event.state {
                    MatchState::Pressed => EventState::Pressed,
                    MatchState::Released => EventState::Released,
                },
            },
        )
    }

    fn error<W: Write>(
        output: &mut W,
        reply_to: Option<u64>,
        code: &str,
        message: &str,
        retryable: bool,
    ) -> Result<(), String> {
        emit(
            output,
            &HelperMessage::Error {
                reply_to,
                code: code.into(),
                message: message.into(),
                retryable,
            },
        )
    }
}

fn emit<W: Write>(output: &mut W, message: &HelperMessage) -> Result<(), String> {
    let line = encode_helper_line(message).map_err(|error| error.to_string())?;
    output
        .write_all(&line)
        .and_then(|()| output.flush())
        .map_err(|error| format!("cannot write protocol output: {error}"))
}

fn summary_error(summary: &ScanSummary) -> (&'static str, &'static str) {
    if summary.permission_denied > 0 {
        ("permission-denied", "keyboard devices are not readable")
    } else if summary.keyboards == 0 {
        ("no-keyboards", "no keyboard devices were found")
    } else {
        (
            "no-readable-keyboards",
            "no readable keyboard devices were found",
        )
    }
}

fn report_scan_diagnostic(summary: &ScanSummary) {
    if summary.readable == 0 {
        eprintln!("[slovo-input-helper] {}", summary_error(summary).1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configure_emits_release_before_ack() {
        let mut state = CommandState::new("test".into());
        state.matcher.add_device(1);
        let mut output = Vec::new();
        state.configure(1, 7, "Ctrl+Space", 2, &mut output).unwrap();
        state.matcher.input(
            1,
            slovo_shortcut_core::matcher::InputCode::CtrlLeft,
            slovo_shortcut_core::matcher::InputValue::Down,
        );
        state.matcher.input(
            1,
            slovo_shortcut_core::matcher::InputCode::Primary(57),
            slovo_shortcut_core::matcher::InputValue::Down,
        );
        output.clear();
        state.configure(2, 8, "Alt+KeyA", 2, &mut output).unwrap();
        let messages = output
            .split_inclusive(|byte| *byte == b'\n')
            .map(|line| slovo_shortcut_core::protocol::decode_helper_line(line).unwrap())
            .collect::<Vec<_>>();
        assert!(matches!(
            messages[0],
            HelperMessage::Event {
                generation: 7,
                state: EventState::Released,
                ..
            }
        ));
        assert_eq!(
            messages[1],
            HelperMessage::Configured {
                reply_to: 2,
                generation: 8,
                device_count: 2
            }
        );
    }

    #[test]
    fn scan_errors_have_stable_classification() {
        assert_eq!(
            summary_error(&ScanSummary {
                keyboards: 0,
                readable: 0,
                permission_denied: 0
            })
            .0,
            "no-keyboards"
        );
        assert_eq!(
            summary_error(&ScanSummary {
                keyboards: 2,
                readable: 0,
                permission_denied: 0
            })
            .0,
            "no-readable-keyboards"
        );
        assert_eq!(
            summary_error(&ScanSummary {
                keyboards: 2,
                readable: 0,
                permission_denied: 2
            })
            .0,
            "permission-denied"
        );
    }
}
