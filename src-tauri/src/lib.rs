mod audio;
mod output;
mod portal;
mod settings;
mod transcription;
mod trigger;

use audio::AudioController;
use serde::Serialize;
use settings::{Settings, TriggerType};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Position, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
use trigger::{Action, TriggerState};

/// Normalized hotkey event used by both the X11 shortcut plugin and the
/// Wayland portal route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyEvent {
    Pressed,
    Released,
}

/// Dispatcher that converts a normalized hotkey event into trigger/recording
/// actions. Shared by the X11 global shortcut handler and the Wayland portal.
pub fn handle_hotkey_action(app: &AppHandle, event: HotkeyEvent) {
    let app_state = app.state::<AppState>();
    let trigger_type = match app_state.settings.lock() {
        Ok(settings) => settings.trigger_type,
        Err(_) => return,
    };
    let action = match app_state.trigger.lock() {
        Ok(mut trigger) => match event {
            HotkeyEvent::Pressed => trigger.press(trigger_type),
            HotkeyEvent::Released => trigger.release(trigger_type),
        },
        Err(_) => return,
    };
    match action {
        Action::Start => start_recording(app, trigger_type == TriggerType::AutoVad),
        Action::Stop => stop_recording(app),
        Action::None => {}
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum StatusKind {
    Ready,
    Recording,
    Transcribing,
    Error,
    Copied,
    Inserted,
}

#[derive(Debug, Clone, Serialize)]
struct StatusEvent {
    kind: StatusKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(rename = "elapsedSeconds", skip_serializing_if = "Option::is_none")]
    elapsed_seconds: Option<u64>,
}

struct AppState {
    settings: Mutex<Settings>,
    trigger: Mutex<TriggerState>,
    audio: AudioController,
    recording: Mutex<Option<Instant>>,
    registered_hotkey: Mutex<String>,
    portal: Mutex<Option<portal::PortalController>>,
    status: Mutex<StatusEvent>,
}

impl AppState {
    fn new(settings: Settings, registered_hotkey: String) -> Self {
        Self {
            registered_hotkey: Mutex::new(registered_hotkey),
            settings: Mutex::new(settings),
            trigger: Mutex::new(TriggerState::default()),
            audio: AudioController::new(),
            recording: Mutex::new(None),
            portal: Mutex::new(None),
            status: Mutex::new(StatusEvent {
                kind: StatusKind::Ready,
                message: None,
                elapsed_seconds: None,
            }),
        }
    }
}

fn emit_status(app: &AppHandle, kind: StatusKind, message: Option<String>) {
    emit_status_event(
        app,
        StatusEvent {
            kind,
            message,
            elapsed_seconds: None,
        },
    );
}

fn emit_status_event(app: &AppHandle, event: StatusEvent) {
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
        let monitor_w = size.width as i32;
        let monitor_h = size.height as i32;
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

/// Temporary diagnostic command that bypasses hotkeys, audio, and status.
#[tauri::command]
fn set_recording_overlay_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("recording-overlay")
        .ok_or_else(|| "recording-overlay window was not found".to_owned())?;
    if visible {
        show_recording_overlay(&window)
    } else {
        hide_recording_overlay(&window)
    }
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    state
        .settings
        .lock()
        .map(|settings| settings.clone())
        .map_err(|_| "settings lock poisoned".into())
}

#[tauri::command]
fn list_input_devices() -> Result<Vec<audio::InputDevice>, String> {
    audio::list_input_devices()
}

#[tauri::command]
fn get_status(state: State<'_, AppState>) -> Result<StatusEvent, String> {
    state
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "status lock poisoned".into())
}

fn canonicalize_hotkey(value: &str) -> Result<String, String> {
    let mut parts = value.trim().split('+').map(str::trim).collect::<Vec<_>>();
    let key = parts.last_mut().ok_or("invalid hotkey: empty value")?;
    *key = match *key {
        // Ё shares the physical Backquote key on the standard Russian layout.
        "Ё" | "ё" | "`" => "Backquote",
        key if key.len() == 1 && key.as_bytes()[0].is_ascii_alphabetic() => {
            return Ok(value.trim().to_owned())
        }
        key => key,
    };
    Ok(parts.join("+"))
}

fn parse_hotkey(value: &str) -> Result<Shortcut, String> {
    canonicalize_hotkey(value)?
        .parse::<Shortcut>()
        .map_err(|error| format!("invalid hotkey: {error}"))
}

#[tauri::command]
fn update_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let mut next = settings;
    next.server_url = crate::settings::normalize_server_url(&next.server_url)?;
    next.hotkey = canonicalize_hotkey(&next.hotkey)?;
    next.input_device = next
        .input_device
        .take()
        .map(|device| device.trim().to_owned())
        .filter(|device| !device.is_empty());
    let new_shortcut = parse_hotkey(&next.hotkey)?;
    let state = app.state::<AppState>();
    let old_hotkey = state
        .registered_hotkey
        .lock()
        .map_err(|_| "hotkey lock poisoned")?
        .clone();

    if next.hotkey != old_hotkey {
        // On Wayland, rebind through the portal and let GNOME ask the user to
        // confirm the new preferred trigger. X11 keeps the plugin route below.
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            eprintln!(
                "[slovo] wayland: re-binding portal for new hotkey {}",
                next.hotkey
            );
            if let Ok(portal) = state.portal.lock() {
                if let Some(controller) = portal.as_ref() {
                    controller.restart(
                        app.clone(),
                        next.hotkey.clone(),
                        "Начать или остановить диктовку".to_owned(),
                    );
                }
            }
        } else {
            app.global_shortcut()
                .register(new_shortcut)
                .map_err(|error| format!("cannot register hotkey: {error}"))?;
            if let Err(error) = app.global_shortcut().unregister(parse_hotkey(&old_hotkey)?) {
                let _ = app.global_shortcut().unregister(new_shortcut);
                return Err(format!("cannot replace previous hotkey: {error}"));
            }
        }
    }

    if let Err(error) = settings::save(&app, &next) {
        if next.hotkey != old_hotkey && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            let _ = app.global_shortcut().unregister(new_shortcut);
            let _ = app.global_shortcut().register(parse_hotkey(&old_hotkey)?);
        }
        return Err(error);
    }
    *state
        .settings
        .lock()
        .map_err(|_| "settings lock poisoned")? = next.clone();
    *state
        .registered_hotkey
        .lock()
        .map_err(|_| "hotkey lock poisoned")? = next.hotkey.clone();
    Ok(next)
}

fn handle_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let app_state = app.state::<AppState>();
    let registered = match app_state.registered_hotkey.lock() {
        Ok(value) => value.clone(),
        Err(_) => return,
    };
    if parse_hotkey(&registered).as_ref().ok() != Some(shortcut) {
        return;
    }
    let normalized = match event.state() {
        ShortcutState::Pressed => HotkeyEvent::Pressed,
        ShortcutState::Released => HotkeyEvent::Released,
    };
    handle_hotkey_action(app, normalized);
}

fn start_recording(app: &AppHandle, auto_vad: bool) {
    let app_for_stop = app.clone();
    let state = app.state::<AppState>();
    let device_name = state
        .settings
        .lock()
        .ok()
        .and_then(|settings| settings.input_device.clone());
    let result = state.audio.start(
        auto_vad,
        device_name,
        Box::new(move || {
            let app = app_for_stop.clone();
            tauri::async_runtime::spawn(async move { stop_recording(&app) });
        }),
    );
    match result {
        Ok(()) => {
            let started = Instant::now();
            if let Ok(mut recording) = state.recording.lock() {
                *recording = Some(started);
            }
            emit_status_event(
                app,
                StatusEvent {
                    kind: StatusKind::Recording,
                    message: None,
                    elapsed_seconds: Some(0),
                },
            );
            spawn_recording_timer(app.clone(), started);
        }
        Err(error) => {
            if let Ok(mut trigger) = state.trigger.lock() {
                trigger.force_idle();
            }
            emit_status(app, StatusKind::Error, Some(error));
        }
    }
}

fn spawn_recording_timer(app: AppHandle, started: Instant) {
    tauri::async_runtime::spawn(async move {
        let mut elapsed_seconds = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let current_started = app
                .state::<AppState>()
                .recording
                .lock()
                .map(|recording| *recording)
                .unwrap_or(None);
            if current_started != Some(started) {
                break;
            }
            elapsed_seconds += 1;
            emit_status_event(
                &app,
                StatusEvent {
                    kind: StatusKind::Recording,
                    message: None,
                    elapsed_seconds: Some(elapsed_seconds.max(started.elapsed().as_secs())),
                },
            );
        }
    });
}

fn stop_recording(app: &AppHandle) {
    let state = app.state::<AppState>();
    let started = state
        .recording
        .lock()
        .ok()
        .and_then(|mut recording| recording.take());
    if started.is_none() {
        return;
    }
    if let Ok(mut trigger) = state.trigger.lock() {
        trigger.force_idle();
    }
    let wav = match state.audio.stop() {
        Ok(wav) => wav,
        Err(error) => {
            emit_status(app, StatusKind::Error, Some(error));
            return;
        }
    };
    emit_status(app, StatusKind::Transcribing, None);
    let server_url = state
        .settings
        .lock()
        .map(|settings| settings.server_url.clone())
        .unwrap_or_default();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match transcription::transcribe(&server_url, wav).await {
            Ok(text) if text.trim().is_empty() => emit_status(&app, StatusKind::Ready, None),
            Ok(text) => match output::copy_and_insert(&text) {
                Ok(true) => emit_status(&app, StatusKind::Inserted, Some(text)),
                Ok(false) => emit_status(
                    &app,
                    StatusKind::Copied,
                    Some("Copied to clipboard; paste injection is unavailable".into()),
                ),
                Err(error) if error.starts_with("clipboard populated;") => {
                    emit_status(&app, StatusKind::Copied, Some(error))
                }
                Err(error) => emit_status(&app, StatusKind::Error, Some(error)),
            },
            Err(error) => emit_status(&app, StatusKind::Error, Some(error)),
        }
    });
}

fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

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
            let (shortcut, registered_hotkey) = match parse_hotkey(&settings.hotkey) {
                Ok(shortcut) => (shortcut, canonicalize_hotkey(&settings.hotkey)?),
                Err(_) => (
                    parse_hotkey(settings::DEFAULT_HOTKEY)?,
                    settings::DEFAULT_HOTKEY.to_owned(),
                ),
            };

            // Manage AppState and the tray FIRST so the app is fully usable
            // even if the portal startup is slow, and so that any portal
            // hotkey events that arrive before setup() returns find the state
            // already in place (otherwise app.state::<AppState>() panics).
            app.manage(AppState::new(settings.clone(), registered_hotkey.clone()));
            setup_tray(app.handle())?;

            // On Wayland, global-hotkey's XGrabKey cannot intercept native
            // keys, so we run the XDG Desktop Portal GlobalShortcuts client in
            // the background (fire-and-forget — never block setup()). On X11 we
            // keep the tauri-plugin-global-shortcut route, registered here.
            let is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
            if is_wayland {
                eprintln!("[slovo] session: wayland; starting portal in background");
                let controller = portal::PortalController::new(
                    app.handle().clone(),
                    settings.hotkey.clone(),
                    "Начать или остановить диктовку".to_owned(),
                );
                if let Ok(mut portal) = app.state::<AppState>().portal.lock() {
                    *portal = Some(controller);
                }
            } else {
                eprintln!("[slovo] session: x11; registering global shortcut");
                app.global_shortcut().register(shortcut)?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            get_status,
            list_input_devices,
            set_recording_overlay_visible
        ])
        .run(tauri::generate_context!())
        .expect("error while running Slovo");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    #[test]
    fn cyrillic_yo_canonicalizes_to_physical_backquote() {
        assert_eq!(canonicalize_hotkey("Ctrl+Ё").unwrap(), "Ctrl+Backquote");
        let shortcut = parse_hotkey("Ctrl+Ё").unwrap();
        assert_eq!(shortcut.mods, Modifiers::CONTROL);
        assert_eq!(shortcut.key, Code::Backquote);
    }

    #[test]
    fn physical_key_forms_and_existing_shortcuts_still_parse() {
        assert_eq!(parse_hotkey("Ctrl+Backquote").unwrap().key, Code::Backquote);
        assert_eq!(
            parse_hotkey("Control+Shift+Space").unwrap().key,
            Code::Space
        );
        assert_eq!(parse_hotkey("Ctrl+KeyQ").unwrap().key, Code::KeyQ);
        assert!(parse_hotkey("Ctrl+Ж").is_err());
    }
}
