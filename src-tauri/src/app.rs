//! Application entrypoint: tray menu, plugin wiring, and the run loop.

use crate::hotkey::{canonicalize_hotkey, handle_shortcut, parse_hotkey, show_settings};
use crate::portal;
use crate::settings;
use crate::shortcut::{
    detect_linux_session, BackendKind, LinuxSession, ShortcutBackendStatus, ShortcutChord,
    ShortcutManager,
};
use crate::state::{
    initialize_shortcut_manager, set_shortcut_status, shutdown_shortcut_manager, AppState,
};
use std::sync::atomic::Ordering;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "Настройки", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings, &quit])?;
    TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => show_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Starts Slovo and runs its Tauri event loop.
///
/// # Panics
///
/// Panics if Tauri cannot build the application from its generated context.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_settings(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(handle_shortcut)
                .build(),
        )
        .setup(|app| {
            let settings = settings::load(app.handle());
            let registered_hotkey = if parse_hotkey(&settings.hotkey).is_ok() {
                canonicalize_hotkey(&settings.hotkey)?
            } else {
                parse_hotkey(settings::DEFAULT_HOTKEY)?;
                settings::DEFAULT_HOTKEY.to_owned()
            };

            // Manage AppState and the tray FIRST so the app is fully usable
            // even if the portal startup is slow, and so that any portal
            // hotkey events that arrive before setup() returns find the state
            // already in place (otherwise app.state::<AppState>() panics).
            #[cfg(target_os = "linux")]
            let session = detect_linux_session(
                std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
                std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
                std::env::var("DISPLAY").ok().as_deref(),
            );
            #[cfg(not(target_os = "linux"))]
            let session = LinuxSession::X11;
            let helper_enabled = std::env::var("SLOVO_EVDEV_HOTKEYS").as_deref() == Ok("1");
            let async_wayland = session == LinuxSession::Wayland && helper_enabled;
            let (manager, shortcut_status) = if async_wayland {
                (
                    None,
                    ShortcutBackendStatus::Starting {
                        backend: BackendKind::WaylandHelper,
                    },
                )
            } else {
                let mut manager = if session == LinuxSession::Wayland {
                    ShortcutManager::legacy_portal()
                } else {
                    ShortcutManager::native()
                };
                if manager.kind() != BackendKind::LegacyPortal {
                    let chord = registered_hotkey
                        .parse::<ShortcutChord>()
                        .map_err(|error| error.to_string())?;
                    manager
                        .replace(app.handle(), chord)
                        .map_err(|error| error.to_string())?;
                }
                let status = manager.status();
                (Some(manager), status)
            };

            app.manage(AppState::new(
                settings.clone(),
                registered_hotkey.clone(),
                manager,
                shortcut_status.clone(),
            ));
            set_shortcut_status(app.handle(), shortcut_status);
            setup_tray(app.handle())?;

            if async_wayland {
                let app_for_shortcut = app.handle().clone();
                let hotkey = registered_hotkey.clone();
                let spawn_result = std::thread::Builder::new()
                    .name("slovo-wayland-shortcut-init".into())
                    .spawn(move || {
                        let state = app_for_shortcut.state::<AppState>();
                        let result = initialize_shortcut_manager(
                            &state,
                            BackendKind::WaylandHelper,
                            || {
                                ShortcutManager::wayland(app_for_shortcut.clone())
                                    .map_err(|e| e.to_string())
                            },
                            |manager| {
                                let chord = hotkey
                                    .parse::<ShortcutChord>()
                                    .map_err(|error| error.to_string())?;
                                manager
                                    .replace(&app_for_shortcut, chord)
                                    .map_err(|error| error.to_string())
                            },
                        );
                        if !state.shortcut_stopping.load(Ordering::Acquire) {
                            let status = state
                                .shortcut
                                .lock()
                                .map(|runtime| runtime.status.clone())
                                .unwrap_or(ShortcutBackendStatus::Failed {
                                    backend: BackendKind::WaylandHelper,
                                    detail: "shortcut lock poisoned".to_owned(),
                                });
                            set_shortcut_status(&app_for_shortcut, status);
                            if let Err(error) = result {
                                eprintln!(
                                    "[slovo] Wayland shortcut initialization failed: {error}"
                                );
                            }
                        }
                    });
                if let Err(error) = spawn_result {
                    let status = ShortcutBackendStatus::Failed {
                        backend: BackendKind::WaylandHelper,
                        detail: format!("cannot start Wayland shortcut initialization: {error}"),
                    };
                    set_shortcut_status(app.handle(), status);
                    eprintln!("[slovo] cannot start Wayland shortcut initialization: {error}");
                }
            }

            if session == LinuxSession::Wayland && !helper_enabled {
                eprintln!("[slovo] session: wayland; starting legacy portal in background");
                let controller = portal::PortalController::new(
                    app.handle().clone(),
                    settings.hotkey,
                    "Начать или остановить диктовку".to_owned(),
                );
                if let Ok(mut portal) = app.state::<AppState>().portal.lock() {
                    *portal = Some(controller);
                }
            } else if session == LinuxSession::Wayland {
                eprintln!("[slovo] session: wayland; evdev helper enabled");
            } else {
                eprintln!("[slovo] session: native global shortcut");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::commands::get_settings,
            crate::commands::set_hotkey_capture_active,
            crate::commands::update_settings,
            crate::commands::get_status,
            crate::commands::get_shortcut_backend_status,
            crate::commands::get_shortcut_permission_setup,
            crate::commands::retry_shortcut_backend,
            crate::commands::list_input_devices
        ])
        .build(tauri::generate_context!())
        .expect("error while building Slovo")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                if let Some(state) = app.try_state::<AppState>() {
                    // Publish lifecycle state before any status emission so a
                    // detached initializer cannot publish after shutdown starts.
                    state.shortcut_stopping.store(true, Ordering::Release);
                    set_shortcut_status(app, ShortcutBackendStatus::ShuttingDown);
                    let app_for_shutdown = app.clone();
                    if let Err(error) = std::thread::Builder::new()
                        .name("slovo-shortcut-shutdown".into())
                        .spawn(move || {
                            let state = app_for_shutdown.state::<AppState>();
                            if let Err(error) = shutdown_shortcut_manager(&state, |manager| {
                                manager
                                    .shutdown(&app_for_shutdown)
                                    .map_err(|error| error.to_string())
                            }) {
                                eprintln!("[slovo] shortcut shutdown failed: {error}");
                            }
                        })
                    {
                        eprintln!("[slovo] cannot start shortcut shutdown: {error}");
                    }
                }
            }
        });
}
