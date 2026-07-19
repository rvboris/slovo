use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use super::{ShortcutChord, ShortcutError};

fn to_tauri_shortcut(chord: &ShortcutChord) -> Result<Shortcut, ShortcutError> {
    chord
        .to_string()
        .parse::<Shortcut>()
        .map_err(|error| ShortcutError::Tauri(error.to_string()))
}

/// `tauri-plugin-global-shortcut` based shortcut registration.
///
/// The active chord reflects plugin state only after a complete successful
/// operation. Replacement registers the new shortcut before removing the old
/// one so a failed registration never interrupts the current shortcut.
#[derive(Debug, Default)]
pub struct NativeShortcutBackend {
    active: Option<ShortcutChord>,
}

impl NativeShortcutBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn active_chord(&self) -> Option<&ShortcutChord> {
        self.active.as_ref()
    }

    pub fn register(&mut self, app: &AppHandle, chord: ShortcutChord) -> Result<(), ShortcutError> {
        if self.active.as_ref() == Some(&chord) {
            return Ok(());
        }
        if self.active.is_some() {
            return self.replace(app, chord);
        }

        let shortcut = to_tauri_shortcut(&chord)?;
        app.global_shortcut().register(shortcut).map_err(|error| {
            ShortcutError::Backend(format!("cannot register shortcut {chord}: {error}"))
        })?;
        self.active = Some(chord);
        Ok(())
    }

    pub fn replace(&mut self, app: &AppHandle, chord: ShortcutChord) -> Result<(), ShortcutError> {
        let Some(old_chord) = self.active.as_ref() else {
            return self.register(app, chord);
        };
        if old_chord == &chord {
            return Ok(());
        }

        let old_shortcut = to_tauri_shortcut(old_chord)?;
        let new_shortcut = to_tauri_shortcut(&chord)?;
        app.global_shortcut()
            .register(new_shortcut)
            .map_err(|error| {
                ShortcutError::Backend(format!("cannot register shortcut {chord}: {error}"))
            })?;

        if let Err(error) = app.global_shortcut().unregister(old_shortcut) {
            let rollback = app.global_shortcut().unregister(new_shortcut);
            let rollback_note = rollback
                .err()
                .map(|rollback_error| format!("; rollback also failed: {rollback_error}"))
                .unwrap_or_default();
            return Err(ShortcutError::Backend(format!(
                "cannot replace previous shortcut {old_chord}: {error}{rollback_note}"
            )));
        }

        self.active = Some(chord);
        Ok(())
    }

    pub fn shutdown(&mut self, app: &AppHandle) -> Result<(), ShortcutError> {
        let Some(chord) = self.active.as_ref() else {
            return Ok(());
        };
        let shortcut = to_tauri_shortcut(chord)?;
        app.global_shortcut()
            .unregister(shortcut)
            .map_err(|error| {
                ShortcutError::Backend(format!("cannot unregister shortcut {chord}: {error}"))
            })?;
        self.active = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_without_an_active_chord() {
        let backend = NativeShortcutBackend::new();
        assert_eq!(backend.active_chord(), None);
    }
}
