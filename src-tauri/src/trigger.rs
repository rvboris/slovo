use crate::settings::TriggerType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    None,
    Start,
    Stop,
}

#[derive(Debug, Default)]
pub struct TriggerState {
    recording: bool,
}

impl TriggerState {
    pub fn press(&mut self, kind: TriggerType) -> Action {
        match kind {
            TriggerType::Toggle if self.recording => {
                self.recording = false;
                Action::Stop
            }
            TriggerType::Toggle | TriggerType::Hold | TriggerType::AutoVad if !self.recording => {
                self.recording = true;
                Action::Start
            }
            _ => Action::None,
        }
    }

    pub fn release(&mut self, kind: TriggerType) -> Action {
        if kind == TriggerType::Hold && self.recording {
            self.recording = false;
            Action::Stop
        } else {
            Action::None
        }
    }

    pub fn force_idle(&mut self) {
        self.recording = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forced_idle_allows_restart_after_every_trigger_mode() {
        for kind in [TriggerType::Toggle, TriggerType::Hold, TriggerType::AutoVad] {
            let mut state = TriggerState::default();
            assert_eq!(state.release(kind), Action::None);
            assert_eq!(state.press(kind), Action::Start);
            state.force_idle();
            state.force_idle();
            assert_eq!(state.release(kind), Action::None);
            assert_eq!(state.press(kind), Action::Start);
        }
    }

    #[test]
    fn toggle_alternates() {
        let mut state = TriggerState::default();
        assert_eq!(state.press(TriggerType::Toggle), Action::Start);
        assert_eq!(state.release(TriggerType::Toggle), Action::None);
        assert_eq!(state.press(TriggerType::Toggle), Action::Stop);
    }

    #[test]
    fn hold_uses_press_and_release() {
        let mut state = TriggerState::default();
        assert_eq!(state.press(TriggerType::Hold), Action::Start);
        assert_eq!(state.press(TriggerType::Hold), Action::None);
        assert_eq!(state.release(TriggerType::Hold), Action::Stop);
    }

    #[test]
    fn auto_vad_ignores_release() {
        let mut state = TriggerState::default();
        assert_eq!(state.press(TriggerType::AutoVad), Action::Start);
        assert_eq!(state.release(TriggerType::AutoVad), Action::None);
    }
}
