//! Application entrypoint: tray menu, plugin wiring, and the run loop.

use crate::commands::get_shortcut_backend_status;
use crate::hotkey::{canonicalize_hotkey, handle_shortcut, parse_hotkey, show_settings};
use crate::portal;
use crate::settings;
use crate::shortcut::{
    detect_linux_session, BackendKind, LinuxSession, ShortcutBackendStatus, ShortcutChord,
    ShortcutManager,
};
use crate::state::{set_shortcut_status, with_shortcut_manager, AppState};
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
            let mut manager = if session == LinuxSession::Wayland && helper_enabled {
                eprintln!("[slovo] setup: creating Wayland shortcut manager");
                let m = ShortcutManager::wayland(app.handle().clone())?;
                eprintln!("[slovo] setup: Wayland manager created successfully");
                m
            } else if session == LinuxSession::Wayland {
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
            eprintln!("[slovo] setup: storing AppState with shortcut manager");
            app.manage(AppState::new(settings.clone(), registered_hotkey, manager));
            eprintln!("[slovo] setup: AppState stored");
            if let Ok(status) = get_shortcut_backend_status(app.state::<AppState>()) {
                set_shortcut_status(app.handle(), status);
            }
            setup_tray(app.handle())?;

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
                set_shortcut_status(app, ShortcutBackendStatus::ShuttingDown);
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(Err(error)) =
                        with_shortcut_manager(&state, |manager| manager.shutdown(app))
                    {
                        eprintln!("[slovo] shortcut shutdown failed: {error}");
                    }
                }
            }
        });
}
