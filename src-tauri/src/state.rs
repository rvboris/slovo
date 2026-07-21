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
use std::sync::atomic::{AtomicBool, Ordering};
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
/// `manager` and `status` describe the same subsystem. `manager` is absent
/// while asynchronous Wayland initialization has not succeeded, and is also
/// temporarily `take`n during a serialized blocking operation. `status` remains
/// available in both cases and reflects the latest authoritative publication.
pub(crate) struct ShortcutRuntime {
    pub(crate) manager: Option<ShortcutManager>,
    pub(crate) status: ShortcutBackendStatus,
    /// Increments whenever a backend publishes status through the shared state.
    pub(crate) status_revision: u64,
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
/// primitive. Initialization, retry, replace, and shutdown manager mutations
/// hold it for their full duration. It must be acquired BEFORE `shortcut`
/// whenever both are needed; blocking helper IPC never holds `shortcut`.
/// `shortcut_stopping` is lock-free lifecycle state and may be checked at any
/// point, including while an operation owns `shortcut_operations`.
pub struct AppState {
    pub(crate) settings: Mutex<SettingsRuntime>,
    pub(crate) trigger: Mutex<TriggerState>,
    pub(crate) audio: AudioController,
    pub(crate) recording: Mutex<Option<Instant>>,
    pub(crate) shortcut: Mutex<ShortcutRuntime>,
    pub(crate) shortcut_operations: Mutex<()>,
    pub(crate) shortcut_stopping: AtomicBool,
    pub(crate) portal: Mutex<Option<portal::PortalController>>,
    pub(crate) status: Mutex<StatusEvent>,
}

impl AppState {
    pub(crate) fn new(
        settings: Settings,
        registered_hotkey: String,
        shortcut_manager: Option<ShortcutManager>,
        shortcut_status: ShortcutBackendStatus,
    ) -> Self {
        Self {
            settings: Mutex::new(SettingsRuntime {
                settings,
                registered_hotkey,
            }),
            trigger: Mutex::new(TriggerState::default()),
            audio: AudioController::new(),
            recording: Mutex::new(None),
            shortcut: Mutex::new(ShortcutRuntime {
                manager: shortcut_manager,
                status: shortcut_status,
                status_revision: 0,
            }),
            shortcut_operations: Mutex::new(()),
            shortcut_stopping: AtomicBool::new(false),
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

/// Constructs, configures, and installs a missing manager as one serialized
/// operation. Construction and configuration run without the `shortcut` lock,
/// because the Wayland helper publishes status through that same mutex.
pub(crate) fn initialize_shortcut_manager(
    state: &AppState,
    backend: crate::shortcut::BackendKind,
    construct: impl FnOnce() -> Result<ShortcutManager, String>,
    configure: impl FnOnce(&mut ShortcutManager) -> Result<(), String>,
) -> Result<ShortcutBackendStatus, String> {
    let _operation = state
        .shortcut_operations
        .lock()
        .map_err(|_| "shortcut operation lock poisoned")?;
    initialize_shortcut_manager_locked(state, backend, construct, configure)
}

fn initialize_shortcut_manager_locked(
    state: &AppState,
    backend: crate::shortcut::BackendKind,
    construct: impl FnOnce() -> Result<ShortcutManager, String>,
    configure: impl FnOnce(&mut ShortcutManager) -> Result<(), String>,
) -> Result<ShortcutBackendStatus, String> {
    let (status_revision_before_construct, status_before_construct) = {
        let runtime = state
            .shortcut
            .lock()
            .map_err(|_| "shortcut lock poisoned")?;
        if runtime.manager.is_some() {
            return Ok(runtime.status.clone());
        }
        if state.shortcut_stopping.load(Ordering::Acquire) {
            return Err("shortcut backend is shutting down".to_owned());
        }
        (runtime.status_revision, runtime.status.clone())
    };

    let mut manager = match construct() {
        Ok(manager) => manager,
        Err(error) => {
            let mut runtime = state
                .shortcut
                .lock()
                .map_err(|_| "shortcut lock poisoned")?;
            if state.shortcut_stopping.load(Ordering::Acquire) {
                return Err("shortcut backend is shutting down".to_owned());
            }
            let actionable_status_was_published = runtime.status_revision
                != status_revision_before_construct
                && runtime.status != status_before_construct
                && matches!(
                    &runtime.status,
                    ShortcutBackendStatus::PermissionDenied { .. }
                        | ShortcutBackendStatus::DevicesUnavailable { .. }
                );
            if !actionable_status_was_published {
                runtime.status = ShortcutBackendStatus::Failed {
                    backend,
                    detail: error.clone(),
                };
            }
            return Err(error);
        }
    };

    if let Err(error) = configure(&mut manager) {
        let manager_status = manager.status();
        let mut runtime = state
            .shortcut
            .lock()
            .map_err(|_| "shortcut lock poisoned")?;
        if state.shortcut_stopping.load(Ordering::Acquire) {
            manager.invalidate();
            return Err("shortcut backend is shutting down".to_owned());
        }
        runtime.status = match manager_status {
            status @ (ShortcutBackendStatus::PermissionDenied { .. }
            | ShortcutBackendStatus::DevicesUnavailable { .. }) => status,
            _ => ShortcutBackendStatus::Failed {
                backend,
                detail: error.clone(),
            },
        };
        return Err(error);
    }

    let manager_status = manager.status();
    let mut runtime = state
        .shortcut
        .lock()
        .map_err(|_| "shortcut lock poisoned")?;
    if state.shortcut_stopping.load(Ordering::Acquire) {
        manager.invalidate();
        runtime.status = ShortcutBackendStatus::ShuttingDown;
        return Err("shortcut backend is shutting down".to_owned());
    }
    let status_was_newly_published = runtime.status_revision != status_revision_before_construct
        && runtime.status != status_before_construct;
    let status = if status_was_newly_published
        && matches!(
            &runtime.status,
            ShortcutBackendStatus::PermissionDenied { .. }
                | ShortcutBackendStatus::DevicesUnavailable { .. }
                | ShortcutBackendStatus::Failed { .. }
        ) {
        runtime.status.clone()
    } else {
        manager_status
    };
    // The operations lock makes this assignment atomic with the absence check.
    runtime.manager = Some(manager);
    runtime.status = status.clone();
    Ok(status)
}

/// Under one operation lock, retries an installed manager or initializes the
/// missing Wayland manager. Callers never infer absence while another operation
/// has temporarily extracted the manager.
pub(crate) fn retry_or_initialize_shortcut_manager(
    state: &AppState,
    backend: crate::shortcut::BackendKind,
    retry: impl FnOnce(&mut ShortcutManager) -> Result<(), String>,
    construct: impl FnOnce() -> Result<ShortcutManager, String>,
    configure: impl FnOnce(&mut ShortcutManager) -> Result<(), String>,
) -> Result<ShortcutBackendStatus, String> {
    let _operation = state
        .shortcut_operations
        .lock()
        .map_err(|_| "shortcut operation lock poisoned")?;
    if state.shortcut_stopping.load(Ordering::Acquire) {
        return Err("shortcut backend is shutting down".to_owned());
    }

    let manager = state
        .shortcut
        .lock()
        .map_err(|_| "shortcut lock poisoned")?
        .manager
        .take();
    if let Some(manager) = manager {
        let mut guard = ManagerGuard {
            shortcut: &state.shortcut,
            manager: Some(manager),
        };
        let result = retry(guard.manager_mut());
        if state.shortcut_stopping.load(Ordering::Acquire) {
            // Prevent ManagerGuard::drop from reinstalling this manager.
            if let Some(manager) = guard.manager.take() {
                manager.invalidate();
            }
            return Err("shortcut backend is shutting down".to_owned());
        }
        result?;
        return Ok(guard.manager_mut().status());
    }

    initialize_shortcut_manager_locked(state, backend, construct, configure)
}

/// Marks shutdown immediately, then serializes extraction and shutdown of an
/// installed manager. It is intended to run on a worker so an in-flight helper
/// handshake never blocks the event loop.
pub(crate) fn shutdown_shortcut_manager(
    state: &AppState,
    shutdown: impl FnOnce(&mut ShortcutManager) -> Result<(), String>,
) -> Result<(), String> {
    state.shortcut_stopping.store(true, Ordering::Release);
    let _operation = state
        .shortcut_operations
        .lock()
        .map_err(|_| "shortcut operation lock poisoned")?;
    let manager = state
        .shortcut
        .lock()
        .map_err(|_| "shortcut lock poisoned")?
        .manager
        .take();
    if let Some(mut manager) = manager {
        manager.invalidate();
        shutdown(&mut manager)?;
    }
    Ok(())
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
    let manager = runtime
        .manager
        .take()
        .ok_or("shortcut manager is not initialized")?;
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
    let state = app.state::<AppState>();
    let stopping = state.shortcut_stopping.load(Ordering::Acquire);
    if stopping && !matches!(status, ShortcutBackendStatus::ShuttingDown) {
        return;
    }
    if let Ok(mut shortcut) = state.shortcut.lock() {
        // Redundant check under lock to avoid racing the transition to ShuttingDown
        if state.shortcut_stopping.load(Ordering::Acquire)
            && !matches!(status, ShortcutBackendStatus::ShuttingDown)
        {
            return;
        }
        shortcut.status = status.clone();
        shortcut.status_revision = shortcut.status_revision.wrapping_add(1);
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
            status_revision: 0,
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

    fn test_state() -> AppState {
        AppState::new(
            crate::settings::Settings::default(),
            "Control+Shift+Space".to_owned(),
            None,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::WaylandHelper,
            },
        )
    }

    #[test]
    fn initialize_succeeds_and_installs_manager() {
        let state = test_state();
        let status = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        assert_eq!(
            status,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            }
        );
        assert!(state.shortcut.lock().unwrap().manager.is_some());
    }

    #[test]
    fn initialize_construction_failure_leaves_manager_absent() {
        let state = test_state();
        let result = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::WaylandHelper,
            || Err("spawn failed".to_owned()),
            |_| unreachable!("configure should not run"),
        );
        assert_eq!(result, Err("spawn failed".to_owned()));
        let runtime = state.shortcut.lock().unwrap();
        assert!(runtime.manager.is_none());
        assert_eq!(
            runtime.status,
            ShortcutBackendStatus::Failed {
                backend: crate::shortcut::BackendKind::WaylandHelper,
                detail: "spawn failed".to_owned(),
            }
        );
    }

    #[test]
    fn initialize_is_idempotent_when_manager_is_installed() {
        let state = test_state();
        initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        let result = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::WaylandHelper,
            || panic!("second construction must not run"),
            |_| panic!("second configuration must not run"),
        );
        assert_eq!(
            result,
            Ok(ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            })
        );
    }

    #[test]
    fn initialize_aborts_before_construction_after_shutdown() {
        let state = test_state();
        state.shortcut_stopping.store(true, Ordering::Release);
        let result = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::WaylandHelper,
            || panic!("construction must not run after shutdown"),
            |_| unreachable!(),
        );
        assert_eq!(result, Err("shortcut backend is shutting down".to_owned()));
        assert!(state.shortcut.lock().unwrap().manager.is_none());
    }

    #[test]
    fn initialize_does_not_install_when_shutdown_starts_during_construction() {
        let state = test_state();
        let result = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || {
                state.shortcut_stopping.store(true, Ordering::Release);
                Ok(ShortcutManager::native())
            },
            |_| Ok(()),
        );
        assert_eq!(result, Err("shortcut backend is shutting down".to_owned()));
        let runtime = state.shortcut.lock().unwrap();
        assert!(runtime.manager.is_none());
        assert_eq!(runtime.status, ShortcutBackendStatus::ShuttingDown);
    }

    #[test]
    fn initialization_does_not_hold_shortcut_lock() {
        let state = test_state();
        initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || {
                let runtime = state
                    .shortcut
                    .try_lock()
                    .expect("construction must not hold shortcut lock");
                assert!(runtime.manager.is_none());
                drop(runtime);
                Ok(ShortcutManager::native())
            },
            |manager| {
                let runtime = state
                    .shortcut
                    .try_lock()
                    .expect("configuration must not hold shortcut lock");
                assert!(runtime.manager.is_none());
                drop(runtime);
                manager.invalidate();
                Ok(())
            },
        )
        .expect("initialization should succeed");
        assert!(state.shortcut.lock().unwrap().manager.is_some());
    }

    #[test]
    fn retry_or_initialize_retries_installed_manager_without_construction() {
        let state = test_state();
        initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        let status = retry_or_initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            |_| Ok(()),
            || panic!("retry with installed manager must not construct"),
            |_| unreachable!(),
        )
        .expect("retry should succeed");
        assert_eq!(
            status,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            }
        );
        assert!(state.shortcut.lock().unwrap().manager.is_some());
    }

    #[test]
    fn retry_or_initialize_constructs_missing_manager() {
        let state = test_state();
        let status = retry_or_initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            |_| unreachable!("missing manager must not use existing retry"),
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        assert_eq!(
            status,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            }
        );
        assert!(state.shortcut.lock().unwrap().manager.is_some());
    }

    #[test]
    fn shutdown_without_manager_is_benign() {
        let state = test_state();
        let result = shutdown_shortcut_manager(&state, |_| panic!("no manager to shut down"));
        assert_eq!(result, Ok(()));
        assert!(state.shortcut_stopping.load(Ordering::Acquire));
        assert!(state.shortcut.lock().unwrap().manager.is_none());
    }

    #[test]
    fn initialize_after_prior_actionable_failure_uses_new_manager_status() {
        let state = test_state();
        {
            let mut runtime = state.shortcut.lock().unwrap();
            runtime.status = ShortcutBackendStatus::PermissionDenied {
                detail: "no access".to_owned(),
                setup_available: true,
            };
        }
        let status = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        // The new manager's own status (Starting) must win, not the stale
        // PermissionDenied from the previous failed attempt.
        assert_eq!(
            status,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            }
        );
        let runtime = state.shortcut.lock().unwrap();
        assert_eq!(
            runtime.status,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            }
        );
        assert!(runtime.manager.is_some());
    }

    #[test]
    fn retry_does_not_reinstall_manager_after_shutdown_begins() {
        let state = test_state();
        initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        let result = retry_or_initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            |_| {
                state.shortcut_stopping.store(true, Ordering::Release);
                Ok(())
            },
            || panic!("shutdown must not construct a new manager"),
            |_| unreachable!(),
        );
        assert_eq!(result, Err("shortcut backend is shutting down".to_owned()));
        assert!(state.shortcut.lock().unwrap().manager.is_none());
    }
}
