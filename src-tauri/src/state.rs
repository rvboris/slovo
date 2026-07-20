//! Aggregate application state and the helpers that mutate it safely.
//!
//! The app keeps its mutable state behind a small number of `Mutex`es. Two of
//! those mutexes ([`AppState::settings`] and [`AppState::shortcut`]) wrap
//! *consolidated* runtime structs so that values always mutated together
//! cannot drift apart and so the lock-ordering surface is small and explicit.

use crate::audio::AudioController;
use crate::portal;
use crate::settings::Settings;
use crate::shortcut::{ShortcutBackendStatus, ShortcutManager};
use crate::trigger::TriggerState;
use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Position, WebviewWindow};

/// Consolidated settings + registered hotkey string.
///
/// These two values are always mutated together in `update_settings`, so they
/// share a single mutex to make that atomic and to remove a lock-ordering
/// hazard.
pub(crate) struct SettingsRuntime {
    pub(crate) settings: Settings,
    pub(crate) registered_hotkey: String,
}

/// Consolidated shortcut backend runtime.
///
/// `manager` and `status` describe the same subsystem and are mutated
/// together (every manager operation refreshes the status). The optional
/// `manager` is `take`n during a blocking helper operation and restored
/// afterwards; `status` always reflects the latest known state.
pub(crate) struct ShortcutRuntime {
    pub(crate) manager: Option<ShortcutManager>,
    pub(crate) status: ShortcutBackendStatus,
}

/// Aggregate application state.
///
/// # Lock order
///
/// When multiple locks must be held simultaneously, acquire them in the order
/// they appear here to avoid deadlocks:
///   1. `settings`   (`SettingsRuntime`)
///   2. `shortcut`   (`ShortcutRuntime`)
///   3. `trigger`
///   4. `recording`
///   5. `portal`
///   6. `status`
///
/// `shortcut_operations` is a plain `Mutex<()>` used purely as a serialization
/// primitive: it is held for the whole duration of a blocking helper mutation
/// so a re-entrant caller sees the manager as busy instead of deadlocking. It
/// must be acquired BEFORE `shortcut` whenever both are needed.
pub struct AppState {
    pub(crate) settings: Mutex<SettingsRuntime>,
    pub(crate) trigger: Mutex<TriggerState>,
    pub(crate) audio: AudioController,
    pub(crate) recording: Mutex<Option<Instant>>,
    pub(crate) shortcut: Mutex<ShortcutRuntime>,
    pub(crate) shortcut_operations: Mutex<()>,
    pub(crate) portal: Mutex<Option<portal::PortalController>>,
    pub(crate) status: Mutex<StatusEvent>,
}

impl AppState {
    pub(crate) fn new(
        settings: Settings,
        registered_hotkey: String,
        shortcut_manager: ShortcutManager,
    ) -> Self {
        let shortcut_status = shortcut_manager.status();
        Self {
            settings: Mutex::new(SettingsRuntime {
                settings,
                registered_hotkey,
            }),
            trigger: Mutex::new(TriggerState::default()),
            audio: AudioController::new(),
            recording: Mutex::new(None),
            shortcut: Mutex::new(ShortcutRuntime {
                manager: Some(shortcut_manager),
                status: shortcut_status,
            }),
            shortcut_operations: Mutex::new(()),
            portal: Mutex::new(None),
            status: Mutex::new(StatusEvent {
                kind: StatusKind::Ready,
                message: None,
                elapsed_seconds: None,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StatusKind {
    Ready,
    Recording,
    Transcribing,
    Error,
    Copied,
    Inserted,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct StatusEvent {
    pub(crate) kind: StatusKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
    #[serde(rename = "elapsedSeconds", skip_serializing_if = "Option::is_none")]
    pub(crate) elapsed_seconds: Option<u64>,
}

pub(crate) fn emit_status(app: &AppHandle, kind: StatusKind, message: Option<String>) {
    emit_status_event(
        app,
        StatusEvent {
            kind,
            message,
            elapsed_seconds: None,
        },
    );
}

pub(crate) fn emit_status_event(app: &AppHandle, event: StatusEvent) {
    if let Ok(mut current) = app.state::<AppState>().status.lock() {
        *current = event.clone();
    }
    manage_recording_overlay(app, &event);
    let _ = app.emit("slovo://status", event);
}

fn manage_recording_overlay(app: &AppHandle, event: &StatusEvent) {
    let Some(window) = app.get_webview_window("recording-overlay") else {
        return;
    };
    let result = match event.kind {
        StatusKind::Recording => show_recording_overlay(&window),
        _ => hide_recording_overlay(&window),
    };
    if let Err(error) = result {
        eprintln!("[slovo] recording overlay error: {error}");
    }
}

fn show_recording_overlay(window: &WebviewWindow) -> Result<(), String> {
    // Position computation is harmless on X11; on GNOME/Mutter (Wayland) the
    // compositor places the surface itself and `set_position` is a no-op.
    if let Some(monitor) = window
        .primary_monitor()
        .map_err(|error| format!("cannot get primary monitor: {error}"))?
    {
        let size = monitor.size();
        let monitor_w = i32::try_from(size.width)
            .map_err(|_| "primary monitor width exceeds supported range".to_owned())?;
        let monitor_h = i32::try_from(size.height)
            .map_err(|_| "primary monitor height exceeds supported range".to_owned())?;
        let x = (monitor_w - 184) / 2;
        let y = monitor_h - 48 - 48;
        window
            .set_position(Position::Physical(PhysicalPosition { x, y }))
            .map_err(|error| format!("cannot position recording overlay: {error}"))?;
    }
    // Re-assert these at show time: GNOME/Mutter often ignores the static
    // tauri.conf.json window flags and needs them set just before mapping.
    window
        .set_always_on_top(true)
        .map_err(|error| format!("cannot set recording overlay always on top: {error}"))?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| format!("cannot skip taskbar for recording overlay: {error}"))?;
    window
        .show()
        .map_err(|error| format!("cannot show recording overlay: {error}"))?;
    window
        .set_resizable(false)
        .map_err(|error| format!("cannot make recording overlay non-resizable: {error}"))?;
    Ok(())
}

fn hide_recording_overlay(window: &WebviewWindow) -> Result<(), String> {
    window
        .hide()
        .map_err(|error| format!("cannot hide recording overlay: {error}"))
}

/// RAII guard that restores the [`ShortcutManager`] into [`ShortcutRuntime`]
/// when dropped.  This prevents the manager from being permanently lost if the
/// operation panics or returns early.
struct ManagerGuard<'a> {
    shortcut: &'a Mutex<ShortcutRuntime>,
    manager: Option<ShortcutManager>,
}

impl ManagerGuard<'_> {
    /// Returns a mutable reference to the extracted manager.
    fn manager_mut(&mut self) -> &mut ShortcutManager {
        self.manager
            .as_mut()
            .expect("ManagerGuard manager consumed before drop")
    }
}

impl Drop for ManagerGuard<'_> {
    fn drop(&mut self) {
        if let Some(manager) = self.manager.take() {
            // Best-effort restore; if the mutex is poisoned the manager is
            // abandoned, but that state already implies an unrecoverable panic.
            if let Ok(mut runtime) = self.shortcut.lock() {
                runtime.status = manager.status();
                runtime.manager = Some(manager);
            }
        }
    }
}

/// Runs `operation` against the live [`ShortcutManager`] while guaranteeing
/// that neither `set_shared_status` (called by Wayland helper methods) nor the
/// protocol reader thread can deadlock on `state.shortcut`.
///
/// # Design
///
/// The manager is **taken** out of [`ShortcutRuntime`] under `shortcut` lock,
/// after which the lock is dropped.  The operation then runs free of the
/// `shortcut` mutex — so any internal status publication
/// (`set_shared_status`) or channel wait (`wait_for`) cannot cause a
/// self-deadlock or circular wait with the reader thread.
///
/// A [`ManagerGuard`] restores the manager and refreshes the cached status on
/// drop (including on panic/early-return), so readers always see a consistent
/// runtime.
///
/// `shortcut_operations` is still acquired first as a serialization primitive,
/// ensuring a second caller cannot observe the temporarily empty manager slot.
pub(crate) fn with_shortcut_manager<T>(
    state: &AppState,
    operation: impl FnOnce(&mut ShortcutManager) -> T,
) -> Result<T, String> {
    with_extracted_shortcut_manager(&state.shortcut, &state.shortcut_operations, operation)
}

fn with_extracted_shortcut_manager<T>(
    shortcut: &Mutex<ShortcutRuntime>,
    shortcut_operations: &Mutex<()>,
    operation: impl FnOnce(&mut ShortcutManager) -> T,
) -> Result<T, String> {
    let _operation = shortcut_operations
        .lock()
        .map_err(|_| "shortcut operation lock poisoned")?;
    let mut runtime = shortcut.lock().map_err(|_| "shortcut lock poisoned")?;
    let manager = runtime.manager.take().ok_or("shortcut manager is busy")?;
    drop(runtime);
    // The operation runs without holding `shortcut`.
    let mut guard = ManagerGuard {
        shortcut,
        manager: Some(manager),
    };
    let result = operation(guard.manager_mut());
    // ManagerGuard::drop restores the manager and updates the cached status.
    Ok(result)
}

pub(crate) fn set_shortcut_status(app: &AppHandle, status: ShortcutBackendStatus) {
    if let Ok(mut shortcut) = app.state::<AppState>().shortcut.lock() {
        shortcut.status = status.clone();
    }
    let _ = app.emit("slovo://shortcut-status", status);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shortcut_runtime() -> Mutex<ShortcutRuntime> {
        Mutex::new(ShortcutRuntime {
            manager: Some(ShortcutManager::native()),
            status: ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native,
            },
        })
    }

    #[test]
    fn manager_operation_releases_shortcut_lock_and_restores_manager_on_ok() {
        let shortcut = shortcut_runtime();
        let operations = Mutex::new(());

        let result = with_extracted_shortcut_manager(&shortcut, &operations, |_| {
            // Models WaylandSupervisor::set_status publishing into AppState
            // while replace/retry owns the extracted manager.
            let mut runtime = shortcut
                .try_lock()
                .expect("operation must not hold shortcut lock");
            runtime.status = ShortcutBackendStatus::Restarting {
                backend: crate::shortcut::BackendKind::Native,
            };
            drop(runtime);
            Ok::<_, &'static str>(())
        })
        .expect("state operation should run");

        assert_eq!(result, Ok(()));
        assert!(shortcut.lock().unwrap().manager.is_some());
    }

    #[test]
    fn manager_operation_releases_shortcut_lock_and_restores_manager_on_err() {
        let shortcut = shortcut_runtime();
        let operations = Mutex::new(());

        let result = with_extracted_shortcut_manager(&shortcut, &operations, |_| {
            let _runtime = shortcut
                .try_lock()
                .expect("operation must not hold shortcut lock");
            Err::<(), _>("operation failed")
        })
        .expect("state operation should run");

        assert_eq!(result, Err("operation failed"));
        assert!(shortcut.lock().unwrap().manager.is_some());
    }
}
