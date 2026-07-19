use std::collections::{HashMap, HashSet};
use std::ops::{BitOr, BitOrAssign};

use super::chord::{ShortcutChord, ShortcutKey, ShortcutModifier};

pub type DeviceId = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InputCode {
    Primary(u16),
    CtrlLeft,
    CtrlRight,
    AltLeft,
    AltRight,
    ShiftLeft,
    ShiftRight,
    SuperLeft,
    SuperRight,
}

impl InputCode {
    #[must_use]
    pub const fn modifier(self) -> Option<Modifiers> {
        match self {
            Self::CtrlLeft | Self::CtrlRight => Some(Modifiers::CTRL),
            Self::AltLeft | Self::AltRight => Some(Modifiers::ALT),
            Self::ShiftLeft | Self::ShiftRight => Some(Modifiers::SHIFT),
            Self::SuperLeft | Self::SuperRight => Some(Modifiers::SUPER),
            Self::Primary(_) => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputValue {
    Down,
    Up,
    Repeat,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Modifiers(u8);

impl Modifiers {
    pub const NONE: Self = Self(0);
    pub const CTRL: Self = Self(1 << 0);
    pub const ALT: Self = Self(1 << 1);
    pub const SHIFT: Self = Self(1 << 2);
    pub const SUPER: Self = Self(1 << 3);

    #[must_use]
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

impl BitOr for Modifiers {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for Modifiers {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChordSpec {
    pub modifiers: Modifiers,
    pub primary: InputCode,
}

impl From<&ShortcutChord> for ChordSpec {
    fn from(chord: &ShortcutChord) -> Self {
        let mut modifiers = Modifiers::NONE;
        for modifier in chord.modifiers() {
            modifiers |= match modifier {
                ShortcutModifier::Control => Modifiers::CTRL,
                ShortcutModifier::Alt => Modifiers::ALT,
                ShortcutModifier::Shift => Modifiers::SHIFT,
                ShortcutModifier::Super => Modifiers::SUPER,
            };
        }
        Self {
            modifiers,
            primary: InputCode::from(chord.key()),
        }
    }
}

impl From<ShortcutChord> for ChordSpec {
    fn from(chord: ShortcutChord) -> Self {
        Self::from(&chord)
    }
}

impl From<&ShortcutKey> for InputCode {
    fn from(key: &ShortcutKey) -> Self {
        let code = match key {
            ShortcutKey::Key(letter) => match letter {
                'A' => 30,
                'B' => 48,
                'C' => 46,
                'D' => 32,
                'E' => 18,
                'F' => 33,
                'G' => 34,
                'H' => 35,
                'I' => 23,
                'J' => 36,
                'K' => 37,
                'L' => 38,
                'M' => 50,
                'N' => 49,
                'O' => 24,
                'P' => 25,
                'Q' => 16,
                'R' => 19,
                'S' => 31,
                'T' => 20,
                'U' => 22,
                'V' => 47,
                'W' => 17,
                'X' => 45,
                'Y' => 21,
                'Z' => 44,
                _ => unreachable!("ShortcutKey only contains ASCII A-Z"),
            },
            ShortcutKey::Digit(digit) => match digit {
                0 => 11,
                1..=9 => u16::from(*digit) + 1,
                _ => unreachable!("ShortcutKey only contains digits 0-9"),
            },
            ShortcutKey::Function(number) => match number {
                1..=10 => u16::from(*number) + 58,
                11 => 87,
                12 => 88,
                13..=24 => u16::from(*number) + 170,
                _ => unreachable!("ShortcutKey only contains F1-F24"),
            },
            ShortcutKey::Backquote => 41,
            ShortcutKey::Backslash => 43,
            ShortcutKey::BracketLeft => 26,
            ShortcutKey::BracketRight => 27,
            ShortcutKey::Comma => 51,
            ShortcutKey::Equal => 13,
            ShortcutKey::Minus => 12,
            ShortcutKey::Period => 52,
            ShortcutKey::Quote => 40,
            ShortcutKey::Semicolon => 39,
            ShortcutKey::Slash => 53,
            ShortcutKey::Backspace => 14,
            ShortcutKey::Delete => 111,
            ShortcutKey::End => 107,
            ShortcutKey::Enter => 28,
            ShortcutKey::Home => 102,
            ShortcutKey::Insert => 110,
            ShortcutKey::PageDown => 109,
            ShortcutKey::PageUp => 104,
            ShortcutKey::Space => 57,
            ShortcutKey::Tab => 15,
            ShortcutKey::ArrowDown => 108,
            ShortcutKey::ArrowLeft => 105,
            ShortcutKey::ArrowRight => 106,
            ShortcutKey::ArrowUp => 103,
        };
        Self::Primary(code)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchState {
    Pressed,
    Released,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MatchEvent {
    pub generation: u64,
    pub state: MatchState,
}

#[derive(Debug, Default)]
struct DeviceState {
    down: HashSet<InputCode>,
}

#[derive(Debug, Default)]
pub struct Matcher {
    devices: HashMap<DeviceId, DeviceState>,
    configured: Option<(u64, ChordSpec)>,
    active: bool,
    stopped: bool,
}

impl Matcher {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_device(&mut self, device: DeviceId) {
        if !self.stopped {
            self.devices.entry(device).or_default();
        }
    }

    pub fn remove_device(&mut self, device: DeviceId) -> Option<MatchEvent> {
        self.devices.remove(&device);
        self.release_if_no_longer_matched()
    }

    pub fn sync_dropped(&mut self, device: DeviceId) -> Option<MatchEvent> {
        if let Some(state) = self.devices.get_mut(&device) {
            state.down.clear();
        }
        self.release_if_no_longer_matched()
    }

    pub fn configure(&mut self, generation: u64, chord: ChordSpec) -> Option<MatchEvent> {
        let released = self.release_current();
        self.configured = Some((generation, chord));
        self.stopped = false;
        released
    }

    pub fn input(
        &mut self,
        device: DeviceId,
        code: InputCode,
        value: InputValue,
    ) -> Option<MatchEvent> {
        if self.stopped || value == InputValue::Repeat {
            return None;
        }

        let state = self.devices.get_mut(&device)?;
        let fresh_down = match value {
            InputValue::Down => state.down.insert(code),
            InputValue::Up => {
                state.down.remove(&code);
                false
            }
            InputValue::Repeat => unreachable!(),
        };

        if self.active {
            return self.release_if_no_longer_matched();
        }

        let (generation, chord) = self.configured?;
        if value == InputValue::Down
            && fresh_down
            && code == chord.primary
            && self.is_exactly_matched(chord)
        {
            self.active = true;
            Some(MatchEvent {
                generation,
                state: MatchState::Pressed,
            })
        } else {
            None
        }
    }

    pub fn shutdown(&mut self) -> Option<MatchEvent> {
        let released = self.release_current();
        self.configured = None;
        self.devices.clear();
        self.stopped = true;
        released
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    fn release_if_no_longer_matched(&mut self) -> Option<MatchEvent> {
        let (_, chord) = self.configured?;
        if self.active && !self.is_exactly_matched(chord) {
            self.release_current()
        } else {
            None
        }
    }

    fn release_current(&mut self) -> Option<MatchEvent> {
        if !self.active {
            return None;
        }
        self.active = false;
        self.configured.map(|(generation, _)| MatchEvent {
            generation,
            state: MatchState::Released,
        })
    }

    fn is_exactly_matched(&self, chord: ChordSpec) -> bool {
        self.modifiers_down() == chord.modifiers && self.is_down(chord.primary)
    }

    fn is_down(&self, code: InputCode) -> bool {
        self.devices
            .values()
            .any(|state| state.down.contains(&code))
    }

    fn modifiers_down(&self) -> Modifiers {
        let mut modifiers = Modifiers::NONE;
        for code in self.devices.values().flat_map(|state| state.down.iter()) {
            if let Some(modifier) = code.modifier() {
                modifiers |= modifier;
            }
        }
        modifiers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const D1: DeviceId = 1;
    const D2: DeviceId = 2;
    const SPACE: InputCode = InputCode::Primary(57);
    const DIGIT2: InputCode = InputCode::Primary(3);
    const A: InputCode = InputCode::Primary(30);

    #[test]
    fn converts_every_shortcut_key_to_linux_input_code() {
        let cases = [
            ("KeyA", 30),
            ("KeyB", 48),
            ("KeyC", 46),
            ("KeyD", 32),
            ("KeyE", 18),
            ("KeyF", 33),
            ("KeyG", 34),
            ("KeyH", 35),
            ("KeyI", 23),
            ("KeyJ", 36),
            ("KeyK", 37),
            ("KeyL", 38),
            ("KeyM", 50),
            ("KeyN", 49),
            ("KeyO", 24),
            ("KeyP", 25),
            ("KeyQ", 16),
            ("KeyR", 19),
            ("KeyS", 31),
            ("KeyT", 20),
            ("KeyU", 22),
            ("KeyV", 47),
            ("KeyW", 17),
            ("KeyX", 45),
            ("KeyY", 21),
            ("KeyZ", 44),
            ("Digit0", 11),
            ("Digit1", 2),
            ("Digit2", 3),
            ("Digit3", 4),
            ("Digit4", 5),
            ("Digit5", 6),
            ("Digit6", 7),
            ("Digit7", 8),
            ("Digit8", 9),
            ("Digit9", 10),
            ("F1", 59),
            ("F2", 60),
            ("F3", 61),
            ("F4", 62),
            ("F5", 63),
            ("F6", 64),
            ("F7", 65),
            ("F8", 66),
            ("F9", 67),
            ("F10", 68),
            ("F11", 87),
            ("F12", 88),
            ("F13", 183),
            ("F14", 184),
            ("F15", 185),
            ("F16", 186),
            ("F17", 187),
            ("F18", 188),
            ("F19", 189),
            ("F20", 190),
            ("F21", 191),
            ("F22", 192),
            ("F23", 193),
            ("F24", 194),
            ("Backquote", 41),
            ("Backslash", 43),
            ("BracketLeft", 26),
            ("BracketRight", 27),
            ("Comma", 51),
            ("Equal", 13),
            ("Minus", 12),
            ("Period", 52),
            ("Quote", 40),
            ("Semicolon", 39),
            ("Slash", 53),
            ("Backspace", 14),
            ("Delete", 111),
            ("End", 107),
            ("Enter", 28),
            ("Home", 102),
            ("Insert", 110),
            ("PageDown", 109),
            ("PageUp", 104),
            ("Space", 57),
            ("Tab", 15),
            ("ArrowDown", 108),
            ("ArrowLeft", 105),
            ("ArrowRight", 106),
            ("ArrowUp", 103),
        ];
        for (key, code) in cases {
            let chord: ShortcutChord = format!("Ctrl+{key}").parse().unwrap();
            assert_eq!(
                ChordSpec::from(&chord).primary,
                InputCode::Primary(code),
                "{key}"
            );
        }
    }

    #[test]
    fn chord_conversion_preserves_all_modifier_semantics() {
        let chord: ShortcutChord = "Shift+Logo+Alt+Control+Space".parse().unwrap();
        assert_eq!(
            ChordSpec::from(chord),
            ChordSpec {
                modifiers: Modifiers::CTRL | Modifiers::ALT | Modifiers::SHIFT | Modifiers::SUPER,
                primary: SPACE,
            }
        );
    }

    fn chord(modifiers: Modifiers) -> ChordSpec {
        ChordSpec {
            modifiers,
            primary: SPACE,
        }
    }

    fn configured(modifiers: Modifiers) -> Matcher {
        let mut matcher = Matcher::new();
        matcher.configure(7, chord(modifiers));
        matcher.add_device(D1);
        matcher
    }

    fn pressed() -> MatchEvent {
        MatchEvent {
            generation: 7,
            state: MatchState::Pressed,
        }
    }

    fn released() -> MatchEvent {
        MatchEvent {
            generation: 7,
            state: MatchState::Released,
        }
    }

    #[test]
    fn normal_ordering_presses_once_and_ignores_repeat() {
        let mut matcher = configured(Modifiers::CTRL | Modifiers::SHIFT);
        assert_eq!(
            matcher.input(D1, InputCode::CtrlLeft, InputValue::Down),
            None
        );
        assert_eq!(
            matcher.input(D1, InputCode::ShiftLeft, InputValue::Down),
            None
        );
        assert_eq!(matcher.input(D1, SPACE, InputValue::Down), Some(pressed()));
        assert_eq!(matcher.input(D1, SPACE, InputValue::Repeat), None);
        assert_eq!(matcher.input(D1, SPACE, InputValue::Down), None);
    }

    #[test]
    fn primary_or_modifier_release_releases_once() {
        for released_code in [SPACE, InputCode::CtrlLeft] {
            let mut matcher = configured(Modifiers::CTRL);
            matcher.input(D1, InputCode::CtrlLeft, InputValue::Down);
            matcher.input(D1, SPACE, InputValue::Down);
            assert_eq!(
                matcher.input(D1, released_code, InputValue::Up),
                Some(released())
            );
            assert_eq!(matcher.input(D1, released_code, InputValue::Up), None);
        }
    }

    #[test]
    fn extra_modifier_prevents_activation_and_deactivates() {
        let mut matcher = configured(Modifiers::CTRL);
        matcher.input(D1, InputCode::CtrlLeft, InputValue::Down);
        matcher.input(D1, InputCode::AltLeft, InputValue::Down);
        assert_eq!(matcher.input(D1, SPACE, InputValue::Down), None);
        matcher.input(D1, SPACE, InputValue::Up);
        matcher.input(D1, InputCode::AltLeft, InputValue::Up);
        assert_eq!(matcher.input(D1, SPACE, InputValue::Down), Some(pressed()));
        assert_eq!(
            matcher.input(D1, InputCode::ShiftLeft, InputValue::Down),
            Some(released())
        );
    }

    #[test]
    fn primary_first_then_modifier_does_not_activate() {
        let mut matcher = configured(Modifiers::CTRL);
        matcher.input(D1, SPACE, InputValue::Down);
        assert_eq!(
            matcher.input(D1, InputCode::CtrlLeft, InputValue::Down),
            None
        );
        assert!(!matcher.is_active());
    }

    #[test]
    fn left_and_right_modifiers_are_aggregated_logically() {
        let mut matcher = configured(Modifiers::CTRL);
        matcher.input(D1, InputCode::CtrlRight, InputValue::Down);
        assert_eq!(matcher.input(D1, SPACE, InputValue::Down), Some(pressed()));
    }

    #[test]
    fn same_modifier_on_two_devices_stays_down_until_both_release() {
        let mut matcher = configured(Modifiers::CTRL);
        matcher.add_device(D2);
        matcher.input(D1, InputCode::CtrlLeft, InputValue::Down);
        matcher.input(D2, InputCode::CtrlRight, InputValue::Down);
        matcher.input(D1, SPACE, InputValue::Down);
        assert_eq!(matcher.input(D1, InputCode::CtrlLeft, InputValue::Up), None);
        assert_eq!(
            matcher.input(D2, InputCode::CtrlRight, InputValue::Up),
            Some(released())
        );
    }

    #[test]
    fn chord_can_span_devices() {
        let mut matcher = configured(Modifiers::CTRL | Modifiers::SHIFT);
        matcher.add_device(D2);
        matcher.input(D1, InputCode::CtrlLeft, InputValue::Down);
        matcher.input(D2, InputCode::ShiftRight, InputValue::Down);
        assert_eq!(matcher.input(D2, SPACE, InputValue::Down), Some(pressed()));
    }

    #[test]
    fn alt_digit2_same_device_presses_and_releases() {
        let mut matcher = Matcher::new();
        matcher.add_device(D1);
        matcher.configure(
            7,
            ChordSpec {
                modifiers: Modifiers::ALT,
                primary: DIGIT2,
            },
        );
        matcher.input(D1, InputCode::AltLeft, InputValue::Down);
        assert_eq!(matcher.input(D1, DIGIT2, InputValue::Down), Some(pressed()));
        assert_eq!(matcher.input(D1, DIGIT2, InputValue::Up), Some(released()));
    }

    #[test]
    fn alt_digit2_cross_device_presses_and_device_removal_releases() {
        let mut matcher = Matcher::new();
        matcher.add_device(D1);
        matcher.add_device(D2);
        matcher.configure(
            7,
            ChordSpec {
                modifiers: Modifiers::ALT,
                primary: DIGIT2,
            },
        );
        matcher.input(D1, InputCode::AltRight, InputValue::Down);
        assert_eq!(matcher.input(D2, DIGIT2, InputValue::Down), Some(pressed()));
        assert_eq!(matcher.remove_device(D1), Some(released()));
        assert_eq!(matcher.input(D1, DIGIT2, InputValue::Down), None);
    }

    #[test]
    fn removal_releases_only_when_relevant() {
        let mut matcher = configured(Modifiers::CTRL);
        matcher.add_device(D2);
        matcher.input(D1, InputCode::CtrlLeft, InputValue::Down);
        matcher.input(D1, SPACE, InputValue::Down);
        matcher.input(D2, A, InputValue::Down);
        assert_eq!(matcher.remove_device(D2), None);
        assert_eq!(matcher.remove_device(D1), Some(released()));
    }

    #[test]
    fn sync_dropped_clears_device_and_releases() {
        let mut matcher = configured(Modifiers::CTRL);
        matcher.input(D1, InputCode::CtrlLeft, InputValue::Down);
        matcher.input(D1, SPACE, InputValue::Down);
        assert_eq!(matcher.sync_dropped(D1), Some(released()));
    }

    #[test]
    fn reconfigure_releases_and_held_new_chord_needs_fresh_primary_down() {
        let mut matcher = configured(Modifiers::CTRL);
        matcher.input(D1, InputCode::CtrlLeft, InputValue::Down);
        matcher.input(D1, SPACE, InputValue::Down);
        assert_eq!(
            matcher.configure(8, chord(Modifiers::CTRL)),
            Some(released())
        );
        assert!(!matcher.is_active());
        assert_eq!(
            matcher.input(D1, InputCode::CtrlLeft, InputValue::Down),
            None
        );
        assert_eq!(matcher.input(D1, SPACE, InputValue::Repeat), None);
        matcher.input(D1, SPACE, InputValue::Up);
        assert_eq!(
            matcher.input(D1, SPACE, InputValue::Down),
            Some(MatchEvent {
                generation: 8,
                state: MatchState::Pressed
            })
        );
    }

    #[test]
    fn shutdown_releases_active_match_and_ignores_more_input() {
        let mut matcher = configured(Modifiers::CTRL);
        matcher.input(D1, InputCode::CtrlLeft, InputValue::Down);
        matcher.input(D1, SPACE, InputValue::Down);
        assert_eq!(matcher.shutdown(), Some(released()));
        assert_eq!(matcher.input(D1, SPACE, InputValue::Down), None);
    }
}
