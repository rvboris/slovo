//! Tauri command handlers exposed to the frontend via `invoke_handler`.
//!
//! Each `#[tauri::command]` function here is registered in `app.rs` via
//! `tauri::generate_handler!`. Helper functions that are only used by these
//! commands live alongside them or in their dedicated module
//! (`permissions.rs`).

use crate::audio;
use crate::hotkey::{canonicalize_hotkey, parse_hotkey};
#[cfg(target_os = "linux")]
use crate::permissions::{permission_setup_in_directory, resolve_permission_setup_dir};
use crate::settings::{self, Settings};
use crate::shortcut::{BackendKind, ShortcutBackendStatus, ShortcutChord, ShortcutManager};
use crate::state::{
    retry_or_initialize_shortcut_manager, set_shortcut_status, with_shortcut_manager, AppState,
    SettingsRuntime, StatusEvent,
};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

// Serialize disk writes and hotkey replacement across both settings windows.
static SETTINGS_SAVE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub async fn open_correction_settings(app: AppHandle) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result: Result<(), String> = (|| {
            // Serialize this decision with approval on the main thread.
            if crate::app::exit_approved(&handle) {
                return Ok(());
            }
            let window = if let Some(window) = handle.get_webview_window("correction-settings") {
                window
            } else {
                tauri::WebviewWindowBuilder::new(
                    &handle,
                    "correction-settings",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("Слово — Корректировка текста")
                .decorations(false)
                .inner_size(560.0, 740.0)
                .min_inner_size(360.0, 420.0)
                .build()
                .map_err(|error| error.to_string())?
            };
            window.unminimize().map_err(|error| error.to_string())?;
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())
        })();
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

fn update_correction_settings_with(
    runtime: &mut SettingsRuntime,
    correction: settings::CorrectionSettings,
    save: impl FnOnce(&Settings) -> Result<(), String>,
) -> Result<Settings, String> {
    let mut next = runtime.settings.clone();
    correction.apply(&mut next)?;
    save(&next)?;
    runtime.settings = next.clone();
    Ok(next)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri command parameters are framework-injected.
pub fn update_correction_settings(
    app: AppHandle,
    correction: settings::CorrectionSettings,
) -> Result<Settings, String> {
    let _save = SETTINGS_SAVE
        .lock()
        .map_err(|_| "settings save lock poisoned")?;
    let state = app.state::<AppState>();
    let mut runtime = state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")?;
    let next = update_correction_settings_with(&mut runtime, correction, |next| {
        settings::save(&app, next)
    })?;
    drop(runtime);
    let _ = app.emit("slovo://settings-changed", ());
    Ok(next)
}

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

            let status = state.shortcut.lock().map_or_else(
                |_| ShortcutBackendStatus::Failed {
                    backend: BackendKind::WaylandHelper,
                    detail: "shortcut lock poisoned".to_owned(),
                },
                |runtime| runtime.status.clone(),
            );
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
pub fn set_hotkey_capture_active(
    state: State<'_, AppState>,
    active: bool,
    token: u64,
) -> Result<(), String> {
    state.set_hotkey_capture(active, token)
}

#[cfg(test)]
mod settings_transaction_tests {
    use super::*;

    fn correction(url: Option<&str>) -> settings::CorrectionSettings {
        settings::CorrectionSettings {
            llm_server_url: url.map(str::to_owned),
            llm_model: Some("model".into()),
            llm_api_key: Some("secret".into()),
            llm_prompt: Some("prompt".into()),
        }
    }

    fn runtime(settings: Settings) -> SettingsRuntime {
        SettingsRuntime {
            registered_hotkey: settings.hotkey.clone(),
            settings,
        }
    }

    fn general_fixture() -> (SettingsRuntime, Settings) {
        let original = Settings {
            hotkey: "Control+Shift+Space".into(),
            llm_prompt: Some("authoritative correction".into()),
            llm_api_key: Some("authoritative key".into()),
            ..Settings::default()
        };
        (runtime(original.clone()), original)
    }

    fn general_candidate(old: &Settings, hotkey: &str) -> Settings {
        Settings {
            hotkey: hotkey.into(),
            llm_prompt: Some("stale correction snapshot".into()),
            llm_api_key: Some("stale key".into()),
            input_device: Some("mic".into()),
            ..old.clone()
        }
    }

    fn active_status(chord: &ShortcutChord) -> ShortcutBackendStatus {
        ShortcutBackendStatus::Active {
            backend: BackendKind::Native,
            shortcut: chord.to_string(),
            device_count: None,
        }
    }

    #[test]
    fn external_transaction_callbacks_run_without_state_mutexes() {
        let (initial, original) = general_fixture();
        let settings = std::sync::Mutex::new(initial);
        let shortcut = std::sync::Mutex::new(active_status(&original.hotkey.parse().unwrap()));
        let assert_unlocked = || {
            assert!(settings.try_lock().is_ok(), "settings mutex held");
            assert!(shortcut.try_lock().is_ok(), "shortcut mutex held");
        };
        let mut published = Vec::new();
        let error = update_general_settings_with(
            &settings,
            general_candidate(&original, "Control+Shift+KeyQ"),
            &original.hotkey,
            BackendKind::Native,
            |chord| {
                assert_unlocked();
                Ok((Ok(()), active_status(&chord)))
            },
            |status| {
                assert_unlocked();
                published.push(status);
            },
            |_| {
                assert_unlocked();
                Err("disk failed".into())
            },
            || {
                assert_unlocked();
                Ok(ShortcutBackendStatus::Failed {
                    backend: BackendKind::Native,
                    detail: "latest status".into(),
                })
            },
        );
        assert_eq!(error.unwrap_err(), "disk failed");
        assert_eq!(published.len(), 2);
        assert!(
            matches!(published[1], ShortcutBackendStatus::Failed { ref detail, .. } if detail == "latest status")
        );
        assert_eq!(settings.lock().unwrap().settings, original);
    }

    #[test]
    fn general_invalid_does_not_invoke_external_operations() {
        let (state, original) = general_fixture();
        let state = std::sync::Mutex::new(state);
        let calls = std::cell::Cell::new(0);
        assert!(update_general_settings_with(
            &state,
            general_candidate(&original, "not a chord"),
            &original.hotkey,
            BackendKind::Native,
            |_| {
                calls.set(calls.get() + 1);
                unreachable!()
            },
            |_| {
                calls.set(calls.get() + 1);
            },
            |_| {
                calls.set(calls.get() + 1);
                Ok(())
            },
            || {
                calls.set(calls.get() + 1);
                unreachable!()
            },
        )
        .is_err());
        assert_eq!(calls.get(), 0);
        assert_eq!(state.lock().unwrap().settings, original);
    }

    #[test]
    fn unchanged_settings_preserve_existing_processing_and_skip_hotkey_replacement() {
        let (initial, original) = general_fixture();
        let state = std::sync::Mutex::new(initial);
        let replaces = std::cell::Cell::new(0);
        update_general_settings_with(
            &state,
            general_candidate(&original, &original.hotkey),
            &original.hotkey,
            BackendKind::Native,
            |_| { replaces.set(replaces.get() + 1); unreachable!() },
            |_| {},
            |_| Ok(()),
            || unreachable!(),
        ).unwrap();
        assert_eq!(replaces.get(), 0);
        assert_eq!(state.lock().unwrap().settings.hotkey, original.hotkey);
    }

    #[test]
    fn general_unchanged_skips_shortcut_replacement() {
        let (initial, original) = general_fixture();
        let state = std::sync::Mutex::new(initial);
        let saves = std::cell::Cell::new(0);
        let replaces = std::cell::Cell::new(0);
        update_general_settings_with(
            &state,
            general_candidate(&original, &original.hotkey),
            &original.hotkey,
            BackendKind::Native,
            |_| {
                replaces.set(replaces.get() + 1);
                unreachable!()
            },
            |_| {},
            |next| {
                saves.set(saves.get() + 1);
                assert_eq!(next.llm_prompt, original.llm_prompt);
                Ok(())
            },
            || unreachable!(),
        )
        .unwrap();
        assert_eq!(replaces.get(), 0);
        assert_eq!(saves.get(), 1);
    }

    #[test]
    fn general_success_replaces_publishes_saves_and_commits() {
        let (state, original) = general_fixture();
        let state = std::sync::Mutex::new(state);
        let calls = std::cell::RefCell::new(Vec::new());
        let next = general_candidate(&original, "Control+Shift+KeyA");
        let expected = next.hotkey.parse::<ShortcutChord>().unwrap();
        let returned = update_general_settings_with(
            &state,
            next,
            &original.hotkey,
            BackendKind::Native,
            |chord| {
                calls.borrow_mut().push("replace");
                assert_eq!(chord, expected.clone());
                Ok((Ok(()), active_status(&chord)))
            },
            |_| calls.borrow_mut().push("publish"),
            |saved| {
                calls.borrow_mut().push("save");
                assert_eq!(saved.llm_prompt, original.llm_prompt);
                assert_eq!(saved.llm_api_key, original.llm_api_key);
                Ok(())
            },
            || {
                calls.borrow_mut().push("status");
                Ok(active_status(&expected))
            },
        )
        .unwrap();
        assert_eq!(*calls.borrow(), ["replace", "publish", "save"]);
        let committed = state.lock().unwrap();
        assert_eq!(committed.settings, returned);
        assert_eq!(committed.registered_hotkey, returned.hotkey);
        drop(committed);
        assert_eq!(returned.input_device.as_deref(), Some("mic"));
    }

    #[test]
    fn general_registration_failure_does_not_save_or_commit() {
        let (state, original) = general_fixture();
        let state = std::sync::Mutex::new(state);
        let saves = std::cell::Cell::new(0);
        let publishes = std::cell::Cell::new(0);
        let error = update_general_settings_with(
            &state,
            general_candidate(&original, "Control+Shift+KeyA"),
            &original.hotkey,
            BackendKind::Native,
            |chord| Ok((Err("register".into()), active_status(&chord))),
            |_| publishes.set(publishes.get() + 1),
            |_| {
                saves.set(saves.get() + 1);
                Ok(())
            },
            || unreachable!(),
        )
        .unwrap_err();
        assert_eq!(error, "register");
        assert_eq!(publishes.get(), 1);
        assert_eq!(saves.get(), 0);
        assert_eq!(state.lock().unwrap().settings, original);
        assert_eq!(state.lock().unwrap().registered_hotkey, original.hotkey);
    }

    #[test]
    fn general_save_failure_rolls_back_and_preserves_runtime() {
        let (state, original) = general_fixture();
        let state = std::sync::Mutex::new(state);
        let calls = std::cell::RefCell::new(Vec::new());
        let next = general_candidate(&original, "Control+Shift+KeyA");
        let mut published = Vec::new();
        let returned = update_general_settings_with(
            &state,
            next,
            &original.hotkey,
            BackendKind::Native,
            |chord| {
                calls.borrow_mut().push("replace");
                Ok((Ok(()), active_status(&chord)))
            },
            |status| {
                calls.borrow_mut().push("publish");
                published.push(status);
            },
            |_| {
                calls.borrow_mut().push("save");
                Err("disk".into())
            },
            || {
                calls.borrow_mut().push("status");
                Ok(ShortcutBackendStatus::Failed {
                    backend: BackendKind::Native,
                    detail: "latest status".into(),
                })
            },
        )
        .unwrap_err();
        assert_eq!(returned, "disk");
        assert_eq!(
            *calls.borrow(),
            ["replace", "publish", "save", "replace", "status", "publish"]
        );
        assert!(
            matches!(published.last(), Some(ShortcutBackendStatus::Failed { detail, .. }) if detail == "latest status")
        );
        assert_eq!(state.lock().unwrap().settings, original);
        assert_eq!(state.lock().unwrap().registered_hotkey, original.hotkey);
    }

    #[test]
    fn general_rollback_failure_reports_combined_error_and_failed_status() {
        let (state, original) = general_fixture();
        let state = std::sync::Mutex::new(state);
        let calls = std::cell::RefCell::new(Vec::new());
        let error = update_general_settings_with(
            &state,
            general_candidate(&original, "Control+Shift+KeyA"),
            &original.hotkey,
            BackendKind::Native,
            |_| {
                let mut calls = calls.borrow_mut();
                calls.push("replace");
                if calls.len() == 1 {
                    Ok((
                        Ok(()),
                        active_status(&"Control+Shift+KeyA".parse().unwrap()),
                    ))
                } else {
                    Ok((
                        Err("rollback".into()),
                        active_status(&"Control+Shift+KeyA".parse().unwrap()),
                    ))
                }
            },
            |status| {
                calls.borrow_mut().push(
                    if matches!(status, ShortcutBackendStatus::Failed { .. }) {
                        "failed"
                    } else {
                        "publish"
                    },
                );
            },
            |_| {
                calls.borrow_mut().push("save");
                Err("disk".into())
            },
            || unreachable!(),
        )
        .unwrap_err();
        assert_eq!(error, "disk; shortcut rollback failed: rollback");
        assert_eq!(
            *calls.borrow(),
            ["replace", "publish", "save", "replace", "failed"]
        );
        assert_eq!(state.lock().unwrap().settings, original);
    }

    #[test]
    fn general_manager_acquisition_failure_propagates_before_status_publish() {
        let (state, original) = general_fixture();
        let state = std::sync::Mutex::new(state);
        let publishes = std::cell::Cell::new(0);
        let result = update_general_settings_with(
            &state,
            general_candidate(&original, "Control+Shift+KeyA"),
            &original.hotkey,
            BackendKind::Native,
            |_| Err("manager lock poisoned".into()),
            |_| publishes.set(publishes.get() + 1),
            |_| panic!("must not save"),
            || unreachable!(),
        );
        assert_eq!(result.unwrap_err(), "manager lock poisoned");
        assert_eq!(publishes.get(), 0);
        assert_eq!(state.lock().unwrap().settings, original);
    }

    #[test]
    fn correction_invalid_does_not_save_or_commit() {
        let original = Settings::default();
        let mut state = runtime(original.clone());
        let saves = std::cell::Cell::new(0);
        assert!(update_correction_settings_with(
            &mut state,
            correction(Some("file:///bad")),
            |_| {
                saves.set(saves.get() + 1);
                Ok(())
            }
        )
        .is_err());
        assert_eq!(saves.get(), 0);
        assert_eq!(state.settings, original);
        assert_eq!(state.registered_hotkey, original.hotkey);
    }

    #[test]
    fn correction_save_failure_preserves_runtime_and_registered_hotkey() {
        let original = Settings {
            llm_prompt: Some("existing".into()),
            ..Settings::default()
        };
        let mut state = runtime(original.clone());
        let error = update_correction_settings_with(
            &mut state,
            correction(Some("https://api.example.test")),
            |_| Err("disk".into()),
        );
        assert_eq!(error.unwrap_err(), "disk");
        assert_eq!(state.settings, original);
        assert_eq!(state.registered_hotkey, original.hotkey);
    }

    #[test]
    fn correction_success_persists_returns_and_commits_preserving_general_fields() {
        let original = Settings {
            input_device: Some("mic".into()),
            llm_prompt: Some("old".into()),
            ..Settings::default()
        };
        let mut state = runtime(original.clone());
        let mut persisted = None;
        let returned = update_correction_settings_with(
            &mut state,
            correction(Some("https://api.example.test")),
            |next| {
                persisted = Some(next.clone());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(persisted, Some(returned.clone()));
        assert_eq!(state.settings, returned);
        assert_eq!(state.registered_hotkey, original.hotkey);
        assert_eq!(returned.hotkey, original.hotkey);
        assert_eq!(returned.server_url, original.server_url);
        assert_eq!(returned.trigger_type, original.trigger_type);
        assert_eq!(returned.input_device, original.input_device);
    }
}

#[allow(clippy::too_many_arguments)]
fn update_general_settings_with(
    settings: &std::sync::Mutex<SettingsRuntime>,
    mut next: Settings,
    old_hotkey: &str,
    manager_kind: BackendKind,
    replace: impl FnMut(ShortcutChord) -> Result<(Result<(), String>, ShortcutBackendStatus), String>,
    publish_status: impl FnMut(ShortcutBackendStatus),
    save: impl FnOnce(&Settings) -> Result<(), String>,
    manager_status: impl FnOnce() -> Result<ShortcutBackendStatus, String>,
) -> Result<Settings, String> {
    next.hotkey
        .parse::<ShortcutChord>()
        .map_err(|error| error.to_string())?;
    update_general_settings_transaction(
        settings,
        &mut next,
        old_hotkey,
        manager_kind,
        replace,
        publish_status,
        save,
        manager_status,
    )
}

#[allow(clippy::too_many_arguments)]
fn update_general_settings_transaction(
    settings: &std::sync::Mutex<SettingsRuntime>,
    next: &mut Settings,
    old_hotkey: &str,
    manager_kind: BackendKind,
    mut replace: impl FnMut(
        ShortcutChord,
    ) -> Result<(Result<(), String>, ShortcutBackendStatus), String>,
    mut publish_status: impl FnMut(ShortcutBackendStatus),
    save: impl FnOnce(&Settings) -> Result<(), String>,
    manager_status: impl FnOnce() -> Result<ShortcutBackendStatus, String>,
) -> Result<Settings, String> {
    if next.hotkey != old_hotkey {
        let (result, status) = replace(
            next.hotkey
                .parse()
                .map_err(|error: crate::shortcut::ShortcutError| error.to_string())?,
        )?;
        publish_status(status);
        result?;
    }
    let authoritative = settings
        .lock()
        .map_err(|_| "settings lock poisoned")?
        .settings
        .clone();
    settings::preserve_correction(next, &authoritative);
    if let Err(error) = save(next) {
        if next.hotkey != old_hotkey {
            let old_chord = old_hotkey
                .parse::<ShortcutChord>()
                .map_err(|parse_error| parse_error.to_string())?;
            let (rollback, _) = replace(old_chord)?;
            if let Err(rollback) = rollback {
                publish_status(ShortcutBackendStatus::Failed {
                    backend: manager_kind,
                    detail: "Не удалось восстановить прежнюю горячую клавишу.".to_owned(),
                });
                return Err(format!("{error}; shortcut rollback failed: {rollback}"));
            }
            publish_status(manager_status()?);
        }
        return Err(error);
    }
    let mut runtime = settings.lock().map_err(|_| "settings lock poisoned")?;
    runtime.settings = next.clone();
    runtime.registered_hotkey.clone_from(&next.hotkey);
    drop(runtime);
    Ok(next.clone())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri command parameters are framework-injected.
pub fn update_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let _save = SETTINGS_SAVE
        .lock()
        .map_err(|_| "settings save lock poisoned")?;
    let mut next = settings;
    next.server_url = crate::settings::normalize_server_url(&next.server_url)?;
    next.hotkey = canonicalize_hotkey(&next.hotkey)?;
    next.input_device = next
        .input_device
        .take()
        .map(|device| device.trim().to_owned())
        .filter(|device| !device.is_empty());
    parse_hotkey(&next.hotkey)?;
    next.hotkey
        .parse::<ShortcutChord>()
        .map_err(|error| error.to_string())?;
    let state = app.state::<AppState>();
    // Acquire `settings` then `shortcut` (canonical lock order). Hold both
    // only long enough to snapshot the values we need; we deliberately drop
    // the guards before any blocking helper IPC.
    let (old_hotkey, current_settings) = {
        let runtime = state.settings.lock().map_err(|_| "settings lock poisoned")?;
        (runtime.registered_hotkey.clone(), runtime.settings.clone())
    };
    let changed_hotkey = next.hotkey != old_hotkey;
    let reservation = if changed_hotkey {
        Some(state.reserve_idle_processing()?)
    } else {
        None
    };
    let manager_kind = state
        .shortcut
        .lock()
        .map_err(|_| "shortcut lock poisoned")?
        .status
        .backend();
    settings::preserve_correction(&mut next, &current_settings);
    let result = update_general_settings_with(
        &state.settings,
        next,
        &old_hotkey,
        manager_kind,
        |chord| {
            with_shortcut_manager(&state, |manager| {
                let result = manager.replace(&app, chord);
                let status = manager.status();
                (result.map_err(|error| error.to_string()), status)
            })
        },
        |status| set_shortcut_status(&app, status),
        |next| settings::save(&app, next),
        || with_shortcut_manager(&state, |manager| manager.status()),
    )?;
    drop(reservation);
    let _ = app.emit("slovo://settings-changed", ());
    Ok(result)
}

/// Returns the pending app-exit request id, if any.
///
/// Called by the correction window after registering its exit listener so a
/// request raised before (or during) subscription is not lost.
#[allow(clippy::needless_pass_by_value)] // Tauri command parameters are framework-injected.
#[tauri::command]
pub fn correction_exit_ready(app: AppHandle) -> Option<u64> {
    app.try_state::<crate::app::ExitGate>()
        .and_then(|gate| gate.pending_id())
}

/// Applies the correction window's decision on a pending app-exit request.
#[allow(clippy::needless_pass_by_value)] // Tauri command parameters are framework-injected.
#[tauri::command]
pub async fn resolve_exit_request(
    window: tauri::WebviewWindow,
    app: AppHandle,
    request_id: u64,
    decision: String,
) -> Result<(), String> {
    let approve = match decision.as_str() {
        "approve" => true,
        "cancel" => false,
        other => return Err(format!("unknown exit decision: {other}")),
    };
    let sender_label = window.label().to_owned();
    let handle = app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = crate::app::resolve_exit(&handle, &sender_label, request_id, approve);
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}
