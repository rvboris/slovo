//! Hotkey event normalization, parsing, and the recording lifecycle that a
//! hotkey press triggers.
//!
//! The X11 global-shortcut plugin and the Wayland portal route both feed into
//! [`handle_hotkey_action`], which converts a normalized [`HotkeyEvent`] into a
//! trigger action and, if needed, starts or stops an audio recording.

use crate::output;
use crate::settings::TriggerType;
use crate::state::{emit_status, emit_status_event, AppState, StatusEvent, StatusKind};
use crate::transcription;
use crate::trigger::Action;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutEvent, ShortcutState};

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
    if std::env::var_os("SLOVO_EVDEV_DEBUG").is_some_and(|value| value == "1") {
        eprintln!("[slovo] hotkey action boundary event={event:?}");
    }
    let Some(app_state) = app.try_state::<AppState>() else {
        return;
    };
    let trigger_type = match app_state.settings.lock() {
        Ok(runtime) => runtime.settings.trigger_type,
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

pub(crate) fn handle_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    let app_state = app.state::<AppState>();
    let registered = match app_state.settings.lock() {
        Ok(runtime) => runtime.registered_hotkey.clone(),
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

pub(crate) fn canonicalize_hotkey(value: &str) -> Result<String, String> {
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

pub(crate) fn parse_hotkey(value: &str) -> Result<Shortcut, String> {
    canonicalize_hotkey(value)?
        .parse::<Shortcut>()
        .map_err(|error| format!("invalid hotkey: {error}"))
}

pub(crate) fn start_recording(app: &AppHandle, auto_vad: bool) {
    let app_for_stop = app.clone();
    let state = app.state::<AppState>();
    let device_name = state
        .settings
        .lock()
        .ok()
        .and_then(|runtime| runtime.settings.input_device.clone());
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
                .map_or(None, |recording| *recording);
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

pub(crate) fn stop_recording(app: &AppHandle) {
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
        .map(|runtime| runtime.settings.server_url.clone())
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
                    emit_status(&app, StatusKind::Copied, Some(error));
                }
                Err(error) => emit_status(&app, StatusKind::Error, Some(error)),
            },
            Err(error) => emit_status(&app, StatusKind::Error, Some(error)),
        }
    });
}

pub(crate) fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
