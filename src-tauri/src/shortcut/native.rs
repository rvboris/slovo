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
        if self.active.is_some() {
            return self.replace(app, chord);
        }
        self.register_with(chord, |shortcut| {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|error| error.to_string())
        })
    }

    fn register_with<R>(
        &mut self,
        chord: ShortcutChord,
        mut register: R,
    ) -> Result<(), ShortcutError>
    where
        R: FnMut(Shortcut) -> Result<(), String>,
    {
        if self.active.as_ref() == Some(&chord) {
            return Ok(());
        }
        if self.active.is_some() {
            return Err(ShortcutError::Backend(
                "replacement operation requires unregister support".into(),
            ));
        }

        let shortcut = to_tauri_shortcut(&chord)?;
        register(shortcut).map_err(|error| {
            ShortcutError::Backend(format!("cannot register shortcut {chord}: {error}"))
        })?;
        self.active = Some(chord);
        Ok(())
    }

    pub fn replace(&mut self, app: &AppHandle, chord: ShortcutChord) -> Result<(), ShortcutError> {
        self.replace_with(
            chord,
            |shortcut| {
                app.global_shortcut()
                    .register(shortcut)
                    .map_err(|error| error.to_string())
            },
            |shortcut| {
                app.global_shortcut()
                    .unregister(shortcut)
                    .map_err(|error| error.to_string())
            },
        )
    }

    fn replace_with<R, U>(
        &mut self,
        chord: ShortcutChord,
        mut register: R,
        mut unregister: U,
    ) -> Result<(), ShortcutError>
    where
        R: FnMut(Shortcut) -> Result<(), String>,
        U: FnMut(Shortcut) -> Result<(), String>,
    {
        let Some(old_chord) = self.active.as_ref() else {
            let shortcut = to_tauri_shortcut(&chord)?;
            register(shortcut).map_err(|error| {
                ShortcutError::Backend(format!("cannot register shortcut {chord}: {error}"))
            })?;
            self.active = Some(chord);
            return Ok(());
        };
        if old_chord == &chord {
            return Ok(());
        }

        let old_shortcut = to_tauri_shortcut(old_chord)?;
        let new_shortcut = to_tauri_shortcut(&chord)?;
        register(new_shortcut).map_err(|error| {
            ShortcutError::Backend(format!("cannot register shortcut {chord}: {error}"))
        })?;

        if let Err(error) = unregister(old_shortcut) {
            let rollback = unregister(new_shortcut);
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
        self.shutdown_with(|shortcut| {
            app.global_shortcut()
                .unregister(shortcut)
                .map_err(|error| error.to_string())
        })
    }

    fn shutdown_with<U>(&mut self, mut unregister: U) -> Result<(), ShortcutError>
    where
        U: FnMut(Shortcut) -> Result<(), String>,
    {
        let Some(chord) = self.active.as_ref() else {
            return Ok(());
        };
        let shortcut = to_tauri_shortcut(chord)?;
        unregister(shortcut).map_err(|error| {
            ShortcutError::Backend(format!("cannot unregister shortcut {chord}: {error}"))
        })?;
        self.active = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;

    fn chord(value: &str) -> ShortcutChord {
        ShortcutChord::from_str(value).unwrap()
    }

    #[test]
    fn starts_without_an_active_chord() {
        let backend = NativeShortcutBackend::new();
        assert_eq!(backend.active_chord(), None);
    }

    #[test]
    fn register_success_and_failure_update_active_state_correctly() {
        let mut backend = NativeShortcutBackend::new();
        backend
            .register_with(chord("Ctrl+KeyS"), |_| Ok(()))
            .unwrap();
        assert_eq!(backend.active_chord(), Some(&chord("Ctrl+KeyS")));

        let error = backend.shutdown_with(|_| Err("busy".into())).unwrap_err();
        assert!(error.to_string().contains("busy"));
        assert_eq!(backend.active_chord(), Some(&chord("Ctrl+KeyS")));
    }

    #[test]
    fn same_chord_makes_no_calls() {
        let mut backend = NativeShortcutBackend::new();
        backend
            .register_with(chord("Ctrl+KeyS"), |_| Ok(()))
            .unwrap();
        let calls = std::cell::Cell::new(0);
        backend
            .replace_with(
                chord("Ctrl+KeyS"),
                |_| {
                    calls.set(calls.get() + 1);
                    Ok(())
                },
                |_| {
                    calls.set(calls.get() + 1);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn replacement_registers_new_then_unregisters_old() {
        let mut backend = NativeShortcutBackend::new();
        backend
            .register_with(chord("Ctrl+KeyS"), |_| Ok(()))
            .unwrap();
        let calls = std::cell::RefCell::new(Vec::new());
        backend
            .replace_with(
                chord("Ctrl+KeyD"),
                |shortcut| {
                    calls.borrow_mut().push(format!("register {shortcut:?}"));
                    Ok(())
                },
                |shortcut| {
                    calls.borrow_mut().push(format!("unregister {shortcut:?}"));
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(calls.borrow().len(), 2);
        assert!(calls.borrow()[0].starts_with("register "));
        assert!(calls.borrow()[1].starts_with("unregister "));
        assert_eq!(backend.active_chord(), Some(&chord("Ctrl+KeyD")));
    }

    #[test]
    fn failed_new_registration_preserves_old_without_unregistering() {
        let mut backend = NativeShortcutBackend::new();
        backend
            .register_with(chord("Ctrl+KeyS"), |_| Ok(()))
            .unwrap();
        let unregisters = std::cell::Cell::new(0);
        assert!(backend
            .replace_with(
                chord("Ctrl+KeyD"),
                |_| Err("denied".into()),
                |_| {
                    unregisters.set(unregisters.get() + 1);
                    Ok(())
                }
            )
            .is_err());
        assert_eq!(unregisters.get(), 0);
        assert_eq!(backend.active_chord(), Some(&chord("Ctrl+KeyS")));
    }

    #[test]
    fn failed_old_unregistration_rolls_back_new_and_preserves_old() {
        let mut backend = NativeShortcutBackend::new();
        backend
            .register_with(chord("Ctrl+KeyS"), |_| Ok(()))
            .unwrap();
        let calls = std::cell::Cell::new(0);
        assert!(backend
            .replace_with(
                chord("Ctrl+KeyD"),
                |_| Ok(()),
                |_| {
                    calls.set(calls.get() + 1);
                    if calls.get() == 1 {
                        Err("old busy".into())
                    } else {
                        Ok(())
                    }
                }
            )
            .is_err());
        assert_eq!(calls.get(), 2);
        assert_eq!(backend.active_chord(), Some(&chord("Ctrl+KeyS")));
    }

    #[test]
    fn rollback_error_contains_both_errors() {
        let mut backend = NativeShortcutBackend::new();
        backend
            .register_with(chord("Ctrl+KeyS"), |_| Ok(()))
            .unwrap();
        let calls = std::cell::Cell::new(0);
        let error = backend
            .replace_with(
                chord("Ctrl+KeyD"),
                |_| Ok(()),
                |_| {
                    calls.set(calls.get() + 1);
                    Err(if calls.get() == 1 {
                        "old busy"
                    } else {
                        "rollback busy"
                    }
                    .into())
                },
            )
            .unwrap_err();
        assert!(error.to_string().contains("old busy"));
        assert!(error.to_string().contains("rollback busy"));
    }

    #[test]
    fn shutdown_empty_is_a_noop() {
        let mut backend = NativeShortcutBackend::new();
        let calls = std::cell::Cell::new(0);
        backend
            .shutdown_with(|_| {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn supported_chords_convert() {
        for value in ["Ctrl+KeyA", "Alt+Shift+F12", "Super+ArrowLeft"] {
            assert!(to_tauri_shortcut(&chord(value)).is_ok(), "{value}");
        }
    }
}
