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
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

/// Pending app-exit request awaiting the correction window's decision.
///
/// The gate keeps a single pending request identified by a monotonic id.
/// Stale resolutions are ignored; once approved no new dialog is created.
#[derive(Default)]
pub(crate) struct ExitGate {
    state: Mutex<ExitState>,
}

impl ExitGate {
    /// Current pending exit request id, if any.
    pub(crate) fn pending_id(&self) -> Option<u64> {
        self.state
            .lock()
            .expect("slovo exit gate lock poisoned")
            .pending_id
    }
}

/// Pure decision table of the exit gate, unit-tested below.
#[derive(Default)]
struct ExitState {
    next_id: u64,
    pending_id: Option<u64>,
    approved: bool,
}

enum ExitAction {
    /// Ask the correction window about this request id.
    Ask(u64),
    /// Nothing to ask; exit now.
    Exit,
    /// Already handled; do nothing.
    None,
}

impl ExitState {
    fn request(&mut self, correction_window_open: bool) -> ExitAction {
        if self.approved {
            return ExitAction::None;
        }
        if let Some(request_id) = self.pending_id {
            return ExitAction::Ask(request_id);
        }
        if !correction_window_open {
            self.approved = true;
            return ExitAction::Exit;
        }
        self.next_id += 1;
        let request_id = self.next_id;
        self.pending_id = Some(request_id);
        ExitAction::Ask(request_id)
    }

    fn resolve(&mut self, request_id: u64, approve: bool) -> bool {
        match self.pending_id {
            Some(current) if current == request_id => {
                self.pending_id = None;
                if approve {
                    self.approved = true;
                }
                approve
            }
            _ => false,
        }
    }

    fn destroyed(&mut self) -> bool {
        if self.pending_id.is_some() && !self.approved {
            self.pending_id = None;
            self.approved = true;
            return true;
        }
        false
    }
}

/// Asks the correction window for a decision; exits immediately when absent.
///
/// Idempotent: repeated requests re-notify the same pending id.
pub(crate) fn request_exit(app: &AppHandle) {
    let Some(gate) = app.try_state::<ExitGate>() else {
        app.exit(0);
        return;
    };
    let window = app.get_webview_window("correction-settings");
    let action = {
        let mut state = gate
            .state
            .lock()
            .expect("slovo exit gate lock poisoned");
        state.request(window.is_some())
    };
    match action {
        ExitAction::Ask(request_id) => {
            if let Some(window) = window {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Err(error) = app.emit_to("correction-settings", "slovo://exit-requested", request_id) {
                eprintln!("[slovo] cannot notify correction window about exit: {error}");
            }
        }
        ExitAction::Exit => app.exit(0),
        ExitAction::None => {}
    }
}

/// Whether the app already decided to exit (final approval).
pub(crate) fn exit_approved(app: &AppHandle) -> bool {
    app.try_state::<ExitGate>().is_none_or(|gate| {
        gate.state
            .lock()
            .expect("slovo exit gate lock poisoned")
            .approved
    })
}

/// Applies the correction window's decision for a pending exit request.
///
/// Only the correction window may resolve, and only the current pending id
/// acts; stale or duplicated resolutions are safe no-ops.
pub(crate) fn resolve_exit(
    app: &AppHandle,
    sender_label: &str,
    request_id: u64,
    approve: bool,
) -> Result<(), String> {
    if sender_label != "correction-settings" {
        return Err("exit decisions are only accepted from the correction window".into());
    }
    let gate = app
        .try_state::<ExitGate>()
        .ok_or_else(|| "exit gate is unavailable".to_string())?;
    let exit_now = {
        let mut state = gate
            .state
            .lock()
            .expect("slovo exit gate lock poisoned");
        state.resolve(request_id, approve)
    };
    if exit_now {
        app.exit(0);
    }
    Ok(())
}

/// Re-checks the gate when the correction window is destroyed while a
/// request is pending: the window closed on its own, the pending exit wins.
pub(crate) fn on_correction_destroyed(app: &AppHandle) {
    let Some(gate) = app.try_state::<ExitGate>() else {
        return;
    };
    let exit_now = {
        let mut state = gate
            .state
            .lock()
            .expect("slovo exit gate lock poisoned");
        state.destroyed()
    };
    if exit_now {
        app.exit(0);
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "Настройки", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => show_settings(app),
            "quit" => request_exit(app),
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
    app.manage(ExitGate::default());
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
            crate::commands::update_correction_settings,
            crate::commands::open_correction_settings,
            crate::commands::correction_exit_ready,
            crate::commands::resolve_exit_request,
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
            let mut exiting = false;
            match &event {
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { api, .. },
                    ..
                } if label == "main" => {
                    // Closing main means quitting Slovo; route through the
                    // exit gate so an unsaved correction draft is kept.
                    api.prevent_close();
                    request_exit(app);
                }
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } if label == "correction-settings" => {
                    on_correction_destroyed(app);
                }
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if exit_approved(app) {
                        exiting = true;
                    } else {
                        api.prevent_exit();
                        request_exit(app);
                    }
                }
                tauri::RunEvent::Exit => {
                    exiting = true;
                }
                _ => {}
            }

            if exiting {
                static SHUTDOWN_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
                if SHUTDOWN_STARTED.swap(true, Ordering::AcqRel) { return; }
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
#[cfg(test)]
mod tests {
    use super::{ExitAction, ExitState};

    #[test]
    fn exits_immediately_without_correction_window() {
        let mut state = ExitState::default();
        assert!(matches!(state.request(false), ExitAction::Exit));
        assert!(matches!(state.request(false), ExitAction::None), "already approved");
    }

    #[test]
    fn asks_window_and_repeats_same_id() {
        let mut state = ExitState::default();
        let ExitAction::Ask(first) = state.request(true) else {
            panic!("expected Ask");
        };
        let ExitAction::Ask(second) = state.request(true) else {
            panic!("expected Ask");
        };
        assert_eq!(first, second, "repeated requests are idempotent");
    }

    #[test]
    fn cancel_allows_a_new_request() {
        let mut state = ExitState::default();
        let ExitAction::Ask(first) = state.request(true) else { panic!() };
        assert!(!state.resolve(first, false), "cancel does not exit");
        let ExitAction::Ask(second) = state.request(true) else { panic!() };
        assert_ne!(first, second);
    }

    #[test]
    fn stale_resolutions_are_ignored() {
        let mut state = ExitState::default();
        let ExitAction::Ask(first) = state.request(true) else { panic!() };
        assert!(!state.resolve(first.wrapping_sub(1), true));
        assert!(!state.resolve(first + 1, false));
        assert!(state.resolve(first, true), "current id approves");
        assert!(!state.resolve(first, true), "duplicate approve is a no-op");
    }

    #[test]
    fn destroyed_while_pending_completes_exit_once() {
        let mut state = ExitState::default();
        let _ = state.request(true);
        assert!(state.destroyed());
        assert!(!state.destroyed(), "already approved");
    }
}
