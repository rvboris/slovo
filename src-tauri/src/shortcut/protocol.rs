use serde::{Deserialize, Serialize};
use std::fmt;

use super::chord::ShortcutChord;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_LINE_BYTES: usize = 8 * 1024;

/// Reads one bounded JSONL record. Oversized records are drained through their
/// newline without allowing attacker-controlled unbounded allocation.
pub fn read_bounded_line<R: std::io::BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> std::io::Result<bool> {
    line.clear();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(oversized || !line.is_empty());
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if !oversized {
            let remaining = MAX_LINE_BYTES.saturating_add(1).saturating_sub(line.len());
            line.extend_from_slice(&available[..consumed.min(remaining)]);
            oversized = line.len() > MAX_LINE_BYTES;
        }
        let ended = available[..consumed].last() == Some(&b'\n');
        reader.consume(consumed);
        if ended {
            return Ok(true);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ParentCommand {
    Hello {
        id: u64,
        protocol_version: u32,
        parent_pid: u32,
    },
    Configure {
        id: u64,
        generation: u64,
        chord: String,
    },
    Rescan {
        id: u64,
    },
    Shutdown {
        id: u64,
    },
}

impl ParentCommand {
    pub fn configure(id: u64, generation: u64, chord: &ShortcutChord) -> Self {
        Self::Configure {
            id,
            generation,
            chord: chord.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventState {
    Pressed,
    Released,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum HelperMessage {
    Ready {
        reply_to: u64,
        protocol: u32,
        instance_id: String,
    },
    Configured {
        reply_to: u64,
        generation: u64,
        device_count: usize,
    },
    Event {
        generation: u64,
        seq: u64,
        state: EventState,
    },
    Devices {
        device_count: usize,
    },
    Error {
        reply_to: Option<u64>,
        code: String,
        message: String,
        retryable: bool,
    },
    Bye {
        reply_to: u64,
    },
}

#[derive(Debug)]
pub enum ProtocolError {
    Empty,
    Oversized { size: usize, max: usize },
    InvalidFraming,
    Malformed(serde_json::Error),
    UnsupportedVersion(u32),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(formatter, "protocol line is empty"),
            Self::Oversized { size, max } => {
                write!(formatter, "protocol line is {size} bytes; maximum is {max}")
            }
            Self::InvalidFraming => {
                write!(formatter, "protocol input must contain exactly one line")
            }
            Self::Malformed(error) => write!(formatter, "malformed protocol message: {error}"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported protocol version {version}")
            }
        }
    }
}

impl std::error::Error for ProtocolError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Malformed(error) => Some(error),
            _ => None,
        }
    }
}

pub fn encode_parent_line(command: &ParentCommand) -> Result<Vec<u8>, ProtocolError> {
    encode_line(command)
}

pub fn encode_helper_line(message: &HelperMessage) -> Result<Vec<u8>, ProtocolError> {
    encode_line(message)
}

pub fn decode_parent_line(line: &[u8]) -> Result<ParentCommand, ProtocolError> {
    let command: ParentCommand = decode_line(line)?;
    if let ParentCommand::Hello {
        protocol_version, ..
    } = command
    {
        if protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(protocol_version));
        }
    }
    Ok(command)
}

pub fn decode_helper_line(line: &[u8]) -> Result<HelperMessage, ProtocolError> {
    let message: HelperMessage = decode_line(line)?;
    if let HelperMessage::Ready { protocol, .. } = message {
        if protocol != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(protocol));
        }
    }
    Ok(message)
}

fn encode_line<T: Serialize>(value: &T) -> Result<Vec<u8>, ProtocolError> {
    let mut line = serde_json::to_vec(value).map_err(ProtocolError::Malformed)?;
    line.push(b'\n');
    if line.len() > MAX_LINE_BYTES {
        return Err(ProtocolError::Oversized {
            size: line.len(),
            max: MAX_LINE_BYTES,
        });
    }
    Ok(line)
}

fn decode_line<T: for<'de> Deserialize<'de>>(line: &[u8]) -> Result<T, ProtocolError> {
    if line.is_empty() {
        return Err(ProtocolError::Empty);
    }
    if line.len() > MAX_LINE_BYTES {
        return Err(ProtocolError::Oversized {
            size: line.len(),
            max: MAX_LINE_BYTES,
        });
    }

    let payload = line.strip_suffix(b"\n").unwrap_or(line);
    let payload = payload.strip_suffix(b"\r").unwrap_or(payload);
    if payload.is_empty() || payload.iter().all(u8::is_ascii_whitespace) {
        return Err(ProtocolError::Empty);
    }
    if payload.contains(&b'\n') || payload.contains(&b'\r') {
        return Err(ProtocolError::InvalidFraming);
    }
    serde_json::from_slice(payload).map_err(ProtocolError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;

    #[test]
    fn bounded_reader_caps_and_drains_oversized_no_newline_input() {
        let input = vec![b'x'; MAX_LINE_BYTES * 4];
        let mut reader = std::io::BufReader::new(input.as_slice());
        let mut line = Vec::new();
        assert!(read_bounded_line(&mut reader, &mut line).unwrap());
        assert_eq!(line.len(), MAX_LINE_BYTES + 1);
        assert_eq!(reader.fill_buf().unwrap(), b"");
    }

    #[test]
    fn parent_commands_round_trip() {
        let commands = [
            ParentCommand::Hello {
                id: 1,
                protocol_version: PROTOCOL_VERSION,
                parent_pid: 42,
            },
            ParentCommand::Configure {
                id: 2,
                generation: 7,
                chord: "Ctrl+Shift+Space".into(),
            },
            ParentCommand::Rescan { id: 3 },
            ParentCommand::Shutdown { id: 4 },
        ];
        for command in commands {
            let line = encode_parent_line(&command).unwrap();
            assert_eq!(line.last(), Some(&b'\n'));
            assert_eq!(decode_parent_line(&line).unwrap(), command);
        }
    }

    #[test]
    fn helper_messages_round_trip() {
        let messages = [
            HelperMessage::Ready {
                reply_to: 1,
                protocol: PROTOCOL_VERSION,
                instance_id: "helper-1".into(),
            },
            HelperMessage::Configured {
                reply_to: 2,
                generation: 3,
                device_count: 2,
            },
            HelperMessage::Event {
                generation: 3,
                seq: 9,
                state: EventState::Pressed,
            },
            HelperMessage::Devices { device_count: 1 },
            HelperMessage::Error {
                reply_to: None,
                code: "device_lost".into(),
                message: "gone".into(),
                retryable: true,
            },
            HelperMessage::Bye { reply_to: 4 },
        ];
        for message in messages {
            assert_eq!(
                decode_helper_line(&encode_helper_line(&message).unwrap()).unwrap(),
                message
            );
        }
    }

    #[test]
    fn rejects_version_mismatch() {
        let parent = br#"{"type":"hello","id":1,"protocol_version":2,"parent_pid":4}"#;
        assert!(matches!(
            decode_parent_line(parent),
            Err(ProtocolError::UnsupportedVersion(2))
        ));
        let helper = br#"{"type":"ready","reply_to":1,"protocol":99,"instance_id":"x"}"#;
        assert!(matches!(
            decode_helper_line(helper),
            Err(ProtocolError::UnsupportedVersion(99))
        ));
    }

    #[test]
    fn rejects_empty_malformed_oversized_and_unknown_type() {
        assert!(matches!(
            decode_parent_line(b"\n"),
            Err(ProtocolError::Empty)
        ));
        assert!(matches!(
            decode_parent_line(b"not json"),
            Err(ProtocolError::Malformed(_))
        ));
        assert!(matches!(
            decode_parent_line(&vec![b'x'; MAX_LINE_BYTES + 1]),
            Err(ProtocolError::Oversized { .. })
        ));
        assert!(matches!(
            decode_parent_line(br#"{"type":"launch","id":1}"#),
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[test]
    fn configure_from_chord_uses_canonical_physical_string() {
        let chord: ShortcutChord = "Shift+Meta+Control+Ё".parse().unwrap();
        let command = ParentCommand::configure(4, 9, &chord);
        assert_eq!(
            command,
            ParentCommand::Configure {
                id: 4,
                generation: 9,
                chord: "Ctrl+Shift+Super+Backquote".into(),
            }
        );
        let encoded = encode_parent_line(&command).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(value["chord"], "Ctrl+Shift+Super+Backquote");
        assert!(value.get("key").is_none());
        assert!(value.get("code").is_none());
    }

    #[test]
    fn event_schema_contains_no_raw_key_data() {
        let line = encode_helper_line(&HelperMessage::Event {
            generation: 8,
            seq: 13,
            state: EventState::Released,
        })
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&line).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 4);
        assert!(object.contains_key("type"));
        assert!(object.contains_key("generation"));
        assert!(object.contains_key("seq"));
        assert!(object.contains_key("state"));
        assert!(!object.contains_key("key"));
        assert!(!object.contains_key("code"));
        assert!(!object.contains_key("device"));
    }
}
