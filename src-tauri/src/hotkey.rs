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
    let Some(app_state) = app.try_state::<AppState>() else { return; };
    let Ok(mut processing) = app_state.processing.lock() else { return; };
    handle_hotkey_action_locked(app, event, &mut processing, None);
}

fn handle_hotkey_action_locked(
    app: &AppHandle,
    event: HotkeyEvent,
    processing: &mut bool,
    expected_shortcut: Option<&Shortcut>,
) {
    let Some(app_state) = app.try_state::<AppState>() else { return; };
    if let Some(expected) = expected_shortcut {
        let matches = app_state.settings.lock().is_ok_and(|runtime| {
            parse_hotkey(&runtime.registered_hotkey).as_ref().ok() == Some(expected)
        });
        if !matches { return; }
    }
    if *processing { return; }
    if app_state.is_hotkey_capture_active() { return; }
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
            if app_state.recording.lock().is_ok_and(|recording| recording.is_none()) {
                if let Some(token) = app_state.begin_recording_start() {
                    check_server_and_start_recording(app, trigger_type == TriggerType::AutoVad, token);
                }
            }
        }
        Action::Stop => stop_recording_locked(app, processing),
        Action::None => {}
    }
}

pub(crate) fn handle_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if std::env::var_os("SLOVO_EVDEV_DEBUG").is_some_and(|value| value == "1") {
        eprintln!(
            "[slovo] shortcut plugin event {shortcut:?} state={:?}",
            event.state()
        );
    }
    let app_state = app.state::<AppState>();
    let Ok(mut processing) = app_state.processing.lock() else { return; };
    let normalized = match event.state() {
        ShortcutState::Pressed => HotkeyEvent::Pressed,
        ShortcutState::Released => HotkeyEvent::Released,
    };
    handle_hotkey_action_locked(app, normalized, &mut processing, Some(shortcut));
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

fn check_server_and_start_recording(app: &AppHandle, auto_vad: bool, token: u64) {
    let state = app.state::<AppState>();
    let Ok(runtime) = state.settings.lock() else {
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
    };
    let server_url = runtime.settings.server_url.clone();
    drop(runtime);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let check = transcription::check_server(&server_url).await;
        let state = app.state::<AppState>();
        let Ok(processing) = state.processing.lock() else {
            return;
        };
        if !state.recording_start_is_current(token) {
            return;
        }
        match check {
            Ok(()) => {
                drop(processing);
                start_recording(&app, auto_vad, token);
            }
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
    let Ok(processing) = state.processing.lock() else {
        return;
    };
    if *processing || !state.recording_start_is_current(token) {
        return;
    }
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
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AppState>();
                let Ok(mut processing) = state.processing.lock() else {
                    return;
                };
                if !*processing && state.recording_start_is_current(token.wrapping_add(1)) {
                    stop_recording_locked(&app, &mut processing);
                }
            });
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
                    revision: 0,
                    message: None,
                    correction_warning: None,
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
            let state = app.state::<AppState>();
            let Ok(_processing) = state.processing.lock() else {
                break;
            };
            let current_started = state.recording.lock().map_or(None, |recording| *recording);
            if current_started != Some(started) {
                break;
            }
            elapsed_seconds += 1;
            emit_status_event(
                &app,
                StatusEvent {
                    kind: StatusKind::Recording,
                    revision: 0,
                    message: None,
                    correction_warning: None,
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
                .is_ok_and(|recording| *recording == Some(started));
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

fn stop_recording_locked(app: &AppHandle, processing: &mut bool) {
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
    let settings = state
        .settings
        .lock()
        .map(|runtime| runtime.settings.clone())
        .unwrap_or_default();
    *processing = true;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let correction_settings = settings.clone();
        process_transcription_result(
            &settings,
            transcription::transcribe(&settings.server_url, wav).await,
            &app.state::<AppState>().processing,
            move |text| async move { transcription::correct(&correction_settings, &text).await },
            output::copy_and_insert,
            |event| emit_status_event(&app, event),
        )
        .await;
    });
}

async fn process_transcription_result<C, CFut, O, E>(
    settings: &crate::settings::Settings,
    result: Result<String, String>,
    processing: &std::sync::Mutex<bool>,
    correct: C,
    output_text: O,
    mut emit: E,
) where
    C: FnOnce(String) -> CFut,
    CFut: std::future::Future<Output = Result<String, String>>,
    O: FnOnce(&str) -> Result<bool, String>,
    E: FnMut(StatusEvent),
{
    let mut publish = |kind, message, correction_warning, elapsed_seconds| emit(StatusEvent {
        kind, revision: 0, message, correction_warning, elapsed_seconds,
    });
    match result {
        Ok(text) if text.trim().is_empty() => publish(StatusKind::Ready, None, None, None),
        Ok(mut text) => {
            let mut warning = None;
            if transcription::correction_enabled(settings) {
                publish(StatusKind::Correcting, None, None, None);
                match correct(text.clone()).await {
                    Ok(corrected) => text = corrected,
                    Err(error) => warning = Some(error),
                }
            }
            let correction_warning = warning.map(|detail| format!("Корректировка не выполнена: {detail}"));
            match output_text(&text) {
                Ok(true) => publish(StatusKind::Inserted, None, correction_warning, None),
                Ok(false) => publish(
                    StatusKind::Copied,
                    Some("Copied to clipboard; paste injection is unavailable".into()),
                    correction_warning,
                    None,
                ),
                Err(error) if error.starts_with("clipboard populated;") => {
                    publish(StatusKind::Copied, Some(error), correction_warning, None);
                }
                Err(error) => publish(StatusKind::Error, Some(error), correction_warning, None),
            }
        }
        Err(error) => publish(StatusKind::Error, Some(error), None, None),
    }
    if let Ok(mut processing) = processing.lock() {
        *processing = false;
    }
}

pub(crate) fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod transcription_result_tests {
    use super::*;

    fn settings(enabled: bool) -> crate::settings::Settings {
        crate::settings::Settings {
            llm_server_url: enabled.then(|| "https://example.test".into()),
            llm_model: enabled.then(|| "model".into()),
            llm_api_key: enabled.then(|| "key".into()),
            llm_prompt: enabled.then(|| "prompt".into()),
            ..crate::settings::Settings::default()
        }
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(future)
    }

    fn run(
        config: &crate::settings::Settings,
        result: Result<String, String>,
        correction: Result<String, String>,
        output: Result<bool, String>,
    ) -> (Vec<StatusEvent>, bool, String) {
        let processing = std::sync::Mutex::new(true);
        let events = std::cell::RefCell::new(Vec::new());
        let output_text = std::cell::RefCell::new(String::new());
        block_on(process_transcription_result(
            config,
            result,
            &processing,
            |_| std::future::ready(correction),
            |text| {
                output_text.replace(text.to_owned());
                output
            },
            |event| {
                assert!(*processing.lock().unwrap());
                events.borrow_mut().push(event);
            },
        ));
        let processing = *processing.lock().unwrap();
        (events.into_inner(), processing, output_text.into_inner())
    }

    #[test]
    fn transcript_error_and_blank_never_output() {
        for (result, expected_kind, expected_detail) in [
            (
                Err("transcribe".into()),
                StatusKind::Error,
                Some("transcribe"),
            ),
            (Ok(" \n ".into()), StatusKind::Ready, None),
        ] {
            let output_called = std::cell::Cell::new(false);
            let processing = std::sync::Mutex::new(true);
            let events = std::cell::RefCell::new(Vec::new());
            block_on(process_transcription_result(
                &settings(false),
                result,
                &processing,
                |_| std::future::ready(Ok(String::new())),
                |_| {
                    output_called.set(true);
                    Ok(true)
                },
                |event| events.borrow_mut().push(event),
            ));
            assert!(!output_called.get());
            assert!(!*processing.lock().unwrap());
            assert_eq!(events.borrow().len(), 1);
            let event = &events.borrow()[0];
            assert!(std::mem::discriminant(&event.kind) == std::mem::discriminant(&expected_kind));
            assert_eq!(event.message.as_deref(), expected_detail);
            assert_eq!(event.correction_warning, None);
        }
    }

    #[test]
    fn disabled_correction_outputs_original() {
        let (events, processing, output) = run(
            &settings(false),
            Ok("original".into()),
            Ok("unused".into()),
            Ok(true),
        );
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0].kind, StatusKind::Inserted));
        assert_eq!(events[0].message, None);
        assert_eq!(events[0].correction_warning, None);
        assert!(!processing);
        assert_eq!(output, "original");
    }

    #[test]
    fn correction_success_emits_correcting_and_outputs_corrected_text() {
        let (events, processing, output) = run(
            &settings(true),
            Ok("raw".into()),
            Ok("fixed".into()),
            Ok(true),
        );
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0].kind, StatusKind::Correcting));
        assert!(matches!(events[1].kind, StatusKind::Inserted));
        assert_eq!(events[1].message, None);
        assert_eq!(events[1].correction_warning, None);
        assert_eq!(output, "fixed");
        assert!(!processing);
    }

    #[test]
    fn correction_failure_falls_back_with_warning_for_all_output_results() {
        for (output, kind, message) in [
            (Ok(true), StatusKind::Inserted, None),
            (Ok(false), StatusKind::Copied, Some("Copied to clipboard; paste injection is unavailable")),
            (Err("clipboard populated; key injection failed".into()), StatusKind::Copied, Some("clipboard populated; key injection failed")),
            (Err("insertion failed".into()), StatusKind::Error, Some("insertion failed")),
        ] {
            let (events, processing, output_text) = run(
                &settings(true),
                Ok("raw".into()),
                Err("offline".into()),
                output,
            );
            assert!(matches!(events[0].kind, StatusKind::Correcting));
            assert_eq!(output_text, "raw");
            assert!(!processing);
            let terminal = events.last().unwrap();
            assert!(std::mem::discriminant(&terminal.kind) == std::mem::discriminant(&kind));
            assert_eq!(terminal.message.as_deref(), message);
            assert_eq!(terminal.correction_warning.as_deref(), Some("Корректировка не выполнена: offline"));
        }
    }

    #[test]
    fn insertion_clipboard_and_error_statuses_are_preserved() {
        assert!(matches!(
            run(
                &settings(false),
                Ok("text".into()),
                Ok(String::new()),
                Ok(true)
            )
            .0[0]
                .kind,
            StatusKind::Inserted
        ));
        assert!(matches!(
            run(
                &settings(false),
                Ok("text".into()),
                Ok(String::new()),
                Ok(false)
            )
            .0[0]
                .kind,
            StatusKind::Copied
        ));
        assert!(matches!(
            run(
                &settings(false),
                Ok("text".into()),
                Ok(String::new()),
                Err("clipboard populated; failed".into())
            )
            .0[0]
                .kind,
            StatusKind::Copied
        ));
        assert!(matches!(
            run(
                &settings(false),
                Ok("text".into()),
                Ok(String::new()),
                Err("failed".into())
            )
            .0[0]
                .kind,
            StatusKind::Error
        ));
    }
}
