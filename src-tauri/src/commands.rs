//! Tauri command handlers exposed to the frontend via `invoke_handler`.
//!
//! Each `#[tauri::command]` function here is registered in `app.rs` via
//! `tauri::generate_handler!`. Helper functions that are only used by these
//! commands live alongside them or in their dedicated module
//! (`permissions.rs`).

use crate::audio;
use crate::hotkey::{canonicalize_hotkey, parse_hotkey};
use crate::permissions::{permission_setup_in_directory, resolve_permission_setup_dir};
use crate::settings::{self, Settings};
use crate::shortcut::{BackendKind, ShortcutBackendStatus, ShortcutChord, ShortcutManager};
use crate::state::{
    retry_or_initialize_shortcut_manager, set_shortcut_status, with_shortcut_manager, AppState,
    StatusEvent,
};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri command parameters are framework-injected.
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    state
        .settings
        .lock()
        .map(|runtime| runtime.settings.clone())
        .map_err(|_| "settings lock poisoned".into())
}

#[tauri::command]
pub async fn list_input_devices() -> Result<Vec<audio::InputDevice>, String> {
    tauri::async_runtime::spawn_blocking(audio::list_input_devices)
        .await
        .map_err(|error| format!("internal error while listing input devices: {error}"))?
}

#[tauri::command]
pub async fn check_server_url(server_url: String) -> Result<(), String> {
    crate::transcription::check_server(&server_url).await
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri command parameters are framework-injected.
pub fn get_shortcut_permission_setup(
    app: AppHandle,
) -> Result<crate::permissions::ShortcutPermissionSetup, String> {
    #[cfg(target_os = "linux")]
    {
        // The bundled resource is intentionally resolved for diagnostics, while
        // include_str remains the canonical exact content in dev and bundles.
        let _bundled_rule = app.path().resource_dir().ok().map(|directory| {
            directory
                .join("resources")
                .join(crate::permissions::SHORTCUT_RULE_NAME)
        });
        let directory = resolve_permission_setup_dir(&app);
        crate::permissions::log_permission_setup_dir(&directory);
        let directory = directory.map_err(|error| {
            let detail = format!("cannot resolve shortcut permission directory: {error}");
            crate::permissions::log_permission_setup_message(&detail);
            detail
        })?;
        let setup = permission_setup_in_directory(&directory).inspect_err(|detail| {
            crate::permissions::log_permission_setup_message(detail);
        })?;
        if let Some(path) = setup.prepared_rule_path.as_deref() {
            crate::permissions::log_permission_setup_message(&format!("prepared rule at {path}"));
        }
        Ok(setup)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(crate::permissions::permission_setup_for_path(
            None, false, None,
        ))
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri command parameters are framework-injected.
pub fn get_shortcut_backend_status(
    state: State<'_, AppState>,
) -> Result<ShortcutBackendStatus, String> {
    state
        .shortcut
        .lock()
        .map(|runtime| runtime.status.clone())
        .map_err(|_| "shortcut lock poisoned".into())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri command parameters are framework-injected.
pub fn retry_shortcut_backend(app: AppHandle) -> Result<ShortcutBackendStatus, String> {
    let app_for_retry = app.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("slovo-shortcut-retry".into())
        .spawn(move || {
            let state = app_for_retry.state::<AppState>();
            let hotkey = state
                .settings
                .lock()
                .map(|runtime| runtime.registered_hotkey.clone())
                .map_err(|_| "settings lock poisoned".to_owned());
            let result = hotkey.and_then(|hotkey| {
                retry_or_initialize_shortcut_manager(
                    &state,
                    BackendKind::WaylandHelper,
                    |manager| manager.retry(&app_for_retry).map_err(|e| e.to_string()),
                    || ShortcutManager::wayland(app_for_retry.clone()).map_err(|e| e.to_string()),
                    |manager| {
                        let chord = hotkey
                            .parse::<ShortcutChord>()
                            .map_err(|error| error.to_string())?;
                        manager
                            .replace(&app_for_retry, chord)
                            .map_err(|e| e.to_string())
                    },
                )
            });

            let status = state
                .shortcut
                .lock()
                .map(|runtime| runtime.status.clone())
                .unwrap_or_else(|_| ShortcutBackendStatus::Failed {
                    backend: BackendKind::WaylandHelper,
                    detail: "shortcut lock poisoned".to_owned(),
                });
            set_shortcut_status(&app_for_retry, status);
            let _ = sender.send(result);
        })
        .map_err(|error| format!("cannot start shortcut retry: {error}"))?;
    let status =
        receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => {
                    "Повторный запуск службы горячих клавиш не завершился вовремя.".to_owned()
                }
                mpsc::RecvTimeoutError::Disconnected => {
                    "Служба повторного запуска горячих клавиш остановлена.".to_owned()
                }
            })??;
    set_shortcut_status(&app, status.clone());
    Ok(status)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri command parameters are framework-injected.
pub fn get_status(state: State<'_, AppState>) -> Result<StatusEvent, String> {
    state
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "status lock poisoned".into())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri command parameters are framework-injected.
pub fn set_hotkey_capture_active(state: State<'_, AppState>, active: bool, token: u64) {
    state.set_hotkey_capture(active, token);
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri command parameters are framework-injected.
pub fn update_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let mut next = settings;
    next.server_url = crate::settings::normalize_server_url(&next.server_url)?;
    next.hotkey = canonicalize_hotkey(&next.hotkey)?;
    next.input_device = next
        .input_device
        .take()
        .map(|device| device.trim().to_owned())
        .filter(|device| !device.is_empty());
    parse_hotkey(&next.hotkey)?;
    let new_chord = next
        .hotkey
        .parse::<ShortcutChord>()
        .map_err(|error| error.to_string())?;
    let state = app.state::<AppState>();
    // Acquire `settings` then `shortcut` (canonical lock order). Hold both
    // only long enough to snapshot the values we need; we deliberately drop
    // the guards before any blocking helper IPC.
    let old_hotkey = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .registered_hotkey
        .clone();
    let manager_kind = state
        .shortcut
        .lock()
        .map_err(|_| "shortcut lock poisoned")?
        .status
        .backend();
    if next.hotkey != old_hotkey {
        let result = with_shortcut_manager(&state, |manager| {
            let result = manager.replace(&app, new_chord);
            let status = manager.status();
            (result, status)
        })?;
        set_shortcut_status(&app, result.1);
        result.0.map_err(|error| error.to_string())?;
    }

    if let Err(error) = settings::save(&app, &next) {
        if next.hotkey != old_hotkey {
            let old_chord = old_hotkey
                .parse::<ShortcutChord>()
                .map_err(|parse_error| parse_error.to_string())?;
            if let Err(rollback) =
                with_shortcut_manager(&state, |manager| manager.replace(&app, old_chord))?
            {
                set_shortcut_status(
                    &app,
                    ShortcutBackendStatus::Failed {
                        backend: manager_kind,
                        detail: "Не удалось восстановить прежнюю горячую клавишу.".to_owned(),
                    },
                );
                return Err(format!("{error}; shortcut rollback failed: {rollback}"));
            }
            let status = with_shortcut_manager(&state, |manager| manager.status())?;
            set_shortcut_status(&app, status);
        }
        return Err(error);
    }
    // Commit settings + registered hotkey atomically.
    let mut runtime = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?;
    runtime.settings = next.clone();
    runtime.registered_hotkey.clone_from(&next.hotkey);
    drop(runtime);
    Ok(next)
}
