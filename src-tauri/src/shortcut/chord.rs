use std::fmt;
use std::str::FromStr;

use tauri_plugin_global_shortcut::Shortcut;

/// Modifier keys in the canonical ordering used by the frontend and storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ShortcutModifier {
    Control,
    Alt,
    Shift,
    Super,
}

impl ShortcutModifier {
    const fn canonical_name(self) -> &'static str {
        match self {
            Self::Control => "Ctrl",
            Self::Alt => "Alt",
            Self::Shift => "Shift",
            Self::Super => "Super",
        }
    }
}

/// A physical (layout-independent) key supported by the hotkey editor.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ShortcutKey {
    Key(char),
    Digit(u8),
    Function(u8),
    Backquote,
    Backslash,
    BracketLeft,
    BracketRight,
    Comma,
    Equal,
    Minus,
    Period,
    Quote,
    Semicolon,
    Slash,
    Backspace,
    Delete,
    End,
    Enter,
    Home,
    Insert,
    PageDown,
    PageUp,
    Space,
    Tab,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
}

impl ShortcutKey {
    fn parse(value: &str) -> Result<Self, ShortcutError> {
        if value == "Ё" || value == "ё" || value == "`" {
            return Ok(Self::Backquote);
        }
        if let Some(letter) = value.strip_prefix("Key") {
            let bytes = letter.as_bytes();
            if bytes.len() == 1 && bytes[0].is_ascii_uppercase() {
                return Ok(Self::Key(bytes[0] as char));
            }
        }
        if let Some(digit) = value.strip_prefix("Digit") {
            let bytes = digit.as_bytes();
            if bytes.len() == 1 && bytes[0].is_ascii_digit() {
                return Ok(Self::Digit(bytes[0] - b'0'));
            }
        }
        if let Some(raw_number) = value.strip_prefix('F') {
            if let Ok(number) = raw_number.parse::<u8>() {
                if (1..=24).contains(&number) && number.to_string() == raw_number {
                    return Ok(Self::Function(number));
                }
            }
        }

        let key = match value {
            "Backquote" => Self::Backquote,
            "Backslash" => Self::Backslash,
            "BracketLeft" => Self::BracketLeft,
            "BracketRight" => Self::BracketRight,
            "Comma" => Self::Comma,
            "Equal" => Self::Equal,
            "Minus" => Self::Minus,
            "Period" => Self::Period,
            "Quote" => Self::Quote,
            "Semicolon" => Self::Semicolon,
            "Slash" => Self::Slash,
            "Backspace" => Self::Backspace,
            "Delete" => Self::Delete,
            "End" => Self::End,
            "Enter" => Self::Enter,
            "Home" => Self::Home,
            "Insert" => Self::Insert,
            "PageDown" => Self::PageDown,
            "PageUp" => Self::PageUp,
            "Space" => Self::Space,
            "Tab" => Self::Tab,
            "ArrowDown" => Self::ArrowDown,
            "ArrowLeft" => Self::ArrowLeft,
            "ArrowRight" => Self::ArrowRight,
            "ArrowUp" => Self::ArrowUp,
            _ => return Err(ShortcutError::UnknownKey(value.to_owned())),
        };
        Ok(key)
    }

    fn canonical_name(&self) -> String {
        match self {
            Self::Key(letter) => format!("Key{letter}"),
            Self::Digit(digit) => format!("Digit{digit}"),
            Self::Function(number) => format!("F{number}"),
            Self::Backquote => "Backquote".into(),
            Self::Backslash => "Backslash".into(),
            Self::BracketLeft => "BracketLeft".into(),
            Self::BracketRight => "BracketRight".into(),
            Self::Comma => "Comma".into(),
            Self::Equal => "Equal".into(),
            Self::Minus => "Minus".into(),
            Self::Period => "Period".into(),
            Self::Quote => "Quote".into(),
            Self::Semicolon => "Semicolon".into(),
            Self::Slash => "Slash".into(),
            Self::Backspace => "Backspace".into(),
            Self::Delete => "Delete".into(),
            Self::End => "End".into(),
            Self::Enter => "Enter".into(),
            Self::Home => "Home".into(),
            Self::Insert => "Insert".into(),
            Self::PageDown => "PageDown".into(),
            Self::PageUp => "PageUp".into(),
            Self::Space => "Space".into(),
            Self::Tab => "Tab".into(),
            Self::ArrowDown => "ArrowDown".into(),
            Self::ArrowLeft => "ArrowLeft".into(),
            Self::ArrowRight => "ArrowRight".into(),
            Self::ArrowUp => "ArrowUp".into(),
        }
    }
}

/// A validated physical shortcut with at least one modifier and exactly one key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ShortcutChord {
    modifiers: Vec<ShortcutModifier>,
    key: ShortcutKey,
}

impl ShortcutChord {
    pub fn modifiers(&self) -> &[ShortcutModifier] {
        &self.modifiers
    }

    pub fn key(&self) -> &ShortcutKey {
        &self.key
    }

    /// Converts through the plugin parser to retain its platform-specific behavior.
    pub fn to_tauri_shortcut(&self) -> Result<Shortcut, ShortcutError> {
        self.to_string()
            .parse::<Shortcut>()
            .map_err(|error| ShortcutError::Tauri(error.to_string()))
    }
}

impl FromStr for ShortcutChord {
    type Err = ShortcutError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let value = value.trim();
        if value.is_empty() {
            return Err(ShortcutError::Empty);
        }
        let parts = value.split('+').map(str::trim).collect::<Vec<_>>();
        if parts.iter().any(|part| part.is_empty()) {
            return Err(ShortcutError::Malformed(value.to_owned()));
        }
        if parts.len() < 2 {
            return Err(ShortcutError::MissingModifier);
        }

        let key = ShortcutKey::parse(parts[parts.len() - 1])?;
        let mut modifiers = Vec::new();
        for part in &parts[..parts.len() - 1] {
            let modifier = match *part {
                "Ctrl" | "Control" => ShortcutModifier::Control,
                "Alt" => ShortcutModifier::Alt,
                "Shift" => ShortcutModifier::Shift,
                "Super" | "Meta" | "Logo" => ShortcutModifier::Super,
                other => return Err(ShortcutError::UnknownModifier(other.to_owned())),
            };
            if modifiers.contains(&modifier) {
                return Err(ShortcutError::DuplicateModifier(
                    modifier.canonical_name().to_owned(),
                ));
            }
            modifiers.push(modifier);
        }
        modifiers.sort_by_key(|modifier| match modifier {
            ShortcutModifier::Control => 0,
            ShortcutModifier::Alt => 1,
            ShortcutModifier::Shift => 2,
            ShortcutModifier::Super => 3,
        });

        Ok(Self { modifiers, key })
    }
}

impl fmt::Display for ShortcutChord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for modifier in &self.modifiers {
            write!(formatter, "{}+", modifier.canonical_name())?;
        }
        formatter.write_str(&self.key.canonical_name())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShortcutError {
    Empty,
    MissingModifier,
    Malformed(String),
    UnknownModifier(String),
    DuplicateModifier(String),
    UnknownKey(String),
    Tauri(String),
    Backend(String),
}

impl fmt::Display for ShortcutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("invalid shortcut: empty value"),
            Self::MissingModifier => {
                formatter.write_str("invalid shortcut: a modifier is required")
            }
            Self::Malformed(value) => {
                write!(formatter, "invalid shortcut: malformed value {value:?}")
            }
            Self::UnknownModifier(value) => write!(formatter, "invalid shortcut modifier: {value}"),
            Self::DuplicateModifier(value) => {
                write!(formatter, "duplicate shortcut modifier: {value}")
            }
            Self::UnknownKey(value) => write!(formatter, "invalid shortcut key: {value}"),
            Self::Tauri(error) => write!(formatter, "invalid Tauri shortcut: {error}"),
            Self::Backend(error) => formatter.write_str(error),
        }
    }
}

impl std::error::Error for ShortcutError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn frontend_keys() -> Vec<String> {
        let mut keys = ('A'..='Z')
            .map(|key| format!("Key{key}"))
            .collect::<Vec<_>>();
        keys.extend((0..=9).map(|key| format!("Digit{key}")));
        keys.extend((1..=24).map(|key| format!("F{key}")));
        keys.extend(
            [
                "Backquote",
                "Backslash",
                "BracketLeft",
                "BracketRight",
                "Comma",
                "Equal",
                "Minus",
                "Period",
                "Quote",
                "Semicolon",
                "Slash",
                "Backspace",
                "Delete",
                "End",
                "Enter",
                "Home",
                "Insert",
                "PageDown",
                "PageUp",
                "Space",
                "Tab",
                "ArrowDown",
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
            ]
            .into_iter()
            .map(str::to_owned),
        );
        keys
    }

    #[test]
    fn accepts_and_round_trips_every_frontend_key() {
        for key in frontend_keys() {
            let canonical = format!("Ctrl+{key}");
            let chord: ShortcutChord = canonical
                .parse()
                .unwrap_or_else(|error| panic!("{canonical}: {error}"));
            assert_eq!(chord.to_string(), canonical);
            assert_eq!(chord.to_string().parse::<ShortcutChord>().unwrap(), chord);
        }
    }

    #[test]
    fn canonicalizes_modifier_and_backquote_aliases() {
        for input in ["Control+Ё", "Ctrl+ё", "Meta+`", "Logo+Backquote"] {
            let expected = if input.starts_with("Control") || input.starts_with("Ctrl") {
                "Ctrl+Backquote"
            } else {
                "Super+Backquote"
            };
            assert_eq!(
                input.parse::<ShortcutChord>().unwrap().to_string(),
                expected
            );
        }
        assert_eq!(
            "Shift+Logo+Alt+Control+KeyQ"
                .parse::<ShortcutChord>()
                .unwrap()
                .to_string(),
            "Ctrl+Alt+Shift+Super+KeyQ"
        );
    }

    #[test]
    fn enforces_function_key_boundaries() {
        assert!("Ctrl+F1".parse::<ShortcutChord>().is_ok());
        assert!("Ctrl+F24".parse::<ShortcutChord>().is_ok());
        for invalid in ["F0", "F25", "F01", "F255"] {
            assert!(format!("Ctrl+{invalid}").parse::<ShortcutChord>().is_err());
        }
    }

    #[test]
    fn rejects_missing_modifiers_and_malformed_input() {
        for invalid in [
            "",
            "Space",
            "Ctrl",
            "Ctrl+",
            "+Space",
            "Ctrl++Space",
            "Ctrl+Ctrl+Space",
            "Hyper+Space",
            "Ctrl+Escape",
            "Ctrl+Keya",
            "Ctrl+A",
            "Ctrl+Space+Alt",
        ] {
            assert!(
                invalid.parse::<ShortcutChord>().is_err(),
                "accepted {invalid:?}"
            );
        }
    }

    #[test]
    fn converts_with_the_tauri_parser() {
        for input in [
            "Control+Shift+Space",
            "Alt+KeyA",
            "Super+F24",
            "Ctrl+Backquote",
        ] {
            let chord = input.parse::<ShortcutChord>().unwrap();
            let expected = chord.to_string().parse::<Shortcut>().unwrap();
            assert_eq!(chord.to_tauri_shortcut().unwrap(), expected);
        }
    }
}
