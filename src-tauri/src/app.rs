//! Application entrypoint: tray menu, plugin wiring, and the run loop.

use crate::hotkey::{canonicalize_hotkey, handle_shortcut, parse_hotkey, show_settings};
use crate::settings;
#[cfg(target_os = "linux")]
use crate::shortcut::detect_linux_session;
use crate::shortcut::{
    BackendKind, LinuxSession, ShortcutBackendStatus, ShortcutChord, ShortcutManager,
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
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => show_settings(app),
            "quit" => app.exit(0),
            _ => {}
        });
    // Without an explicit icon the tray shows a blank placeholder on Windows.
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn configure_linux_display_backend() {
    // GNOME Wayland deliberately does not let ordinary toplevel windows choose
    // their position. Use XWayland so the overlay stays at bottom center.
    #[cfg(target_os = "linux")]
    if std::env::var("XDG_SESSION_TYPE").as_deref() == Ok("wayland")
        && std::env::var_os("DISPLAY").is_some()
    {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let settings = settings::load(app.handle());
    let registered_hotkey = if parse_hotkey(&settings.hotkey).is_ok() {
        canonicalize_hotkey(&settings.hotkey)?
    } else {
        parse_hotkey(settings::DEFAULT_HOTKEY)?;
        settings::DEFAULT_HOTKEY.to_owned()
    };

    // Manage AppState and the tray first so the app remains usable while
    // the Wayland helper initializes asynchronously.
    #[cfg(target_os = "linux")]
    let session = detect_linux_session(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("DISPLAY").ok().as_deref(),
    );
    #[cfg(not(target_os = "linux"))]
    let session = LinuxSession::X11;
    let async_wayland = session == LinuxSession::Wayland;
    let (manager, shortcut_status) = if async_wayland {
        (
            None,
            ShortcutBackendStatus::Starting {
                backend: BackendKind::WaylandHelper,
            },
        )
    } else {
        let mut manager = ShortcutManager::native();
        let chord = registered_hotkey
            .parse::<ShortcutChord>()
            .map_err(|error| error.to_string())?;
        manager
            .replace(app.handle(), chord)
            .map_err(|error| error.to_string())?;
        let status = manager.status();
        (Some(manager), status)
    };

    app.manage(AppState::new(
        settings,
        registered_hotkey.clone(),
        manager,
        shortcut_status.clone(),
    ));
    set_shortcut_status(app.handle(), shortcut_status);
    setup_tray(app.handle())?;

    if async_wayland {
        let app_for_shortcut = app.handle().clone();
        let hotkey = registered_hotkey;
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
                    let status = state.shortcut.lock().map_or_else(
                        |_| ShortcutBackendStatus::Failed {
                            backend: BackendKind::WaylandHelper,
                            detail: "shortcut lock poisoned".to_owned(),
                        },
                        |runtime| runtime.status.clone(),
                    );
                    set_shortcut_status(&app_for_shortcut, status);
                    if let Err(error) = result {
                        eprintln!("[slovo] Wayland shortcut initialization failed: {error}");
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

    if session == LinuxSession::Wayland {
        eprintln!("[slovo] session: wayland; initializing shortcut helper");
    } else {
        eprintln!("[slovo] session: native global shortcut");
    }

    Ok(())
}

/// Starts Slovo and runs its Tauri event loop.
///
/// # Panics
///
/// Panics if Tauri cannot build the application from its generated context.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_linux_display_backend();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_settings(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(handle_shortcut)
                .build(),
        )
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            crate::commands::get_settings,
            crate::commands::set_hotkey_capture_active,
            crate::commands::update_settings,
            crate::commands::get_status,
            crate::commands::get_shortcut_backend_status,
            crate::commands::get_shortcut_permission_setup,
            crate::commands::retry_shortcut_backend,
            crate::commands::list_input_devices,
            crate::commands::check_server_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building Slovo")
        .run(|app, event| {
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } = &event
            {
                if label == "main" {
                    app.exit(0);
                }
            }

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
