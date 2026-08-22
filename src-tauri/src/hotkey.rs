//! Hotkey event normalization, parsing, and the recording lifecycle that a
//! hotkey press triggers.
//!
//! The native global-shortcut plugin and Wayland helper both feed into
//! [`handle_hotkey_action`], which converts a normalized [`HotkeyEvent`] into a
//! trigger action and, if needed, starts or stops an audio recording.

use crate::output;
use crate::settings::TriggerType;
use crate::state::{emit_status, emit_status_event, AppState, StatusEvent, StatusKind};
use crate::transcription;
use crate::trigger::Action;
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutEvent, ShortcutState};

/// Poll interval for the live microphone level sent to the recording overlay.
/// Fast enough to feel responsive, slow enough that it never thrashes window
/// machinery (it emits its own event, not a `StatusEvent`, so
/// `manage_recording_overlay` is not involved).
const AUDIO_LEVEL_INTERVAL: Duration = Duration::from_millis(80);

/// Payload for the `slovo://audio-level` event. `device_name` is the cpal
/// device that was actually opened (the system default when no device is
/// configured), so the overlay can show which microphone is live alongside the
/// level — making "wrong device selected" visible at a glance.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioLevel {
    level: f32,
    device_name: String,
}

/// Normalized hotkey event used by both the native shortcut plugin and the
/// Wayland helper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyEvent {
    Pressed,
    Released,
}

/// Dispatcher that converts a normalized hotkey event into trigger/recording
/// actions. Shared by the native shortcut handler and the Wayland helper.
pub fn handle_hotkey_action(app: &AppHandle, event: HotkeyEvent) {
    if std::env::var_os("SLOVO_EVDEV_DEBUG").is_some_and(|value| value == "1") {
        eprintln!("[slovo] hotkey action boundary event={event:?}");
    }
    let Some(app_state) = app.try_state::<AppState>() else {
        return;
    };
    if app_state.is_hotkey_capture_active() {
        return;
    }
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
        Action::Start => {
            check_server_and_start_recording(app, trigger_type == TriggerType::AutoVad)
        }
        Action::Stop => stop_recording(app),
        Action::None => {}
    }
}

pub(crate) fn handle_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if std::env::var_os("SLOVO_EVDEV_DEBUG").is_some_and(|value| value == "1") {
        eprintln!("[slovo] shortcut plugin event {shortcut:?} state={:?}", event.state());
    }
    let app_state = app.state::<AppState>();
    let registered = match app_state.settings.lock() {
        Ok(runtime) => runtime.registered_hotkey.clone(),
        Err(_) => return,
    };
    if parse_hotkey(&registered).as_ref().ok() != Some(shortcut) {
        if std::env::var_os("SLOVO_EVDEV_DEBUG").is_some_and(|value| value == "1") {
            eprintln!(
                "[slovo] shortcut event ignored: registered '{registered}' vs event {shortcut:?}"
            );
        }
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

fn check_server_and_start_recording(app: &AppHandle, auto_vad: bool) {
    let state = app.state::<AppState>();
    let Some(token) = state.begin_recording_start() else {
        return;
    };
    let server_url = match state.settings.lock() {
        Ok(runtime) => runtime.settings.server_url.clone(),
        Err(_) => {
            state.finish_recording_start(token);
            if let Ok(mut trigger) = state.trigger.lock() {
                trigger.force_idle();
            }
            emit_status(
                app,
                StatusKind::Error,
                Some("Не удалось прочитать адрес сервера.".to_owned()),
            );
            return;
        }
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let check = transcription::check_server(&server_url).await;
        let state = app.state::<AppState>();
        if !state.recording_start_is_current(token) {
            return;
        }
        match check {
            Ok(()) => start_recording(&app, auto_vad, token),
            Err(error) => {
                if state.finish_recording_start(token) {
                    if let Ok(mut trigger) = state.trigger.lock() {
                        trigger.force_idle();
                    }
                    emit_status(&app, StatusKind::Error, Some(error));
                }
            }
        }
    });
}

fn start_recording(app: &AppHandle, auto_vad: bool, token: u64) {
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
        Ok(opened_device_name) if state.finish_recording_start(token) => {
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
            spawn_audio_level_loop(app.clone(), started, opened_device_name);
        }
        Ok(_) => {
            let _ = state.audio.stop();
        }
        Err(error) => {
            if state.finish_recording_start(token) {
                if let Ok(mut trigger) = state.trigger.lock() {
                    trigger.force_idle();
                }
                emit_status(app, StatusKind::Error, Some(error));
            }
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

fn spawn_audio_level_loop(app: AppHandle, started: Instant, device_name: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(AUDIO_LEVEL_INTERVAL).await;
            let state = app.state::<AppState>();
            // Exit as soon as this recording is no longer current: a new
            // recording replaces `started` with a fresh Instant, and stop
            // clears it to None. Either way we must stop polling.
            let still_current = state
                .recording
                .lock()
                .map_or(false, |recording| *recording == Some(started));
            if !still_current {
                break;
            }
            let level = state.audio.level();
            // Send a plain payload directly; deliberately not a StatusEvent so
            // `manage_recording_overlay` (which performs window show/hide/resize)
            // is never triggered by the level heartbeat.
            let _ = app.emit(
                "slovo://audio-level",
                AudioLevel {
                    level,
                    device_name: device_name.clone(),
                },
            );
        }
    });
}

pub(crate) fn stop_recording(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.cancel_recording_start();
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
