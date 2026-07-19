mod audio;
mod output;
mod portal;
mod settings;
mod shortcut;
mod transcription;
mod trigger;

use audio::AudioController;
use serde::Serialize;
use settings::{Settings, TriggerType};
use shortcut::{
    detect_linux_session, BackendKind, LinuxSession, ShortcutBackendStatus, ShortcutChord,
    ShortcutManager,
};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Position, State, WebviewWindow};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutEvent, ShortcutState};
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
    if std::env::var_os("SLOVO_EVDEV_DEBUG").is_some_and(|value| value == "1") {
        eprintln!("[slovo] hotkey action boundary event={event:?}");
    }
    let Some(app_state) = app.try_state::<AppState>() else {
        return;
    };
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

const SHORTCUT_RULE_NAME: &str = "72-slovo-input-helper.rules";
const SHORTCUT_RULE_DESTINATION: &str = "/usr/lib/udev/rules.d/72-slovo-input-helper.rules";
const SHORTCUT_RULE: &str = include_str!("../resources/72-slovo-input-helper.rules");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutPermissionSetup {
    supported: bool,
    disclosure: String,
    install_commands: Vec<String>,
    revoke_commands: Vec<String>,
    destination: String,
    installed: bool,
    prepared_rule_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    setup_error: Option<String>,
    note: String,
}

struct AppState {
    settings: Mutex<Settings>,
    trigger: Mutex<TriggerState>,
    audio: AudioController,
    recording: Mutex<Option<Instant>>,
    registered_hotkey: Mutex<String>,
    shortcut_manager: Mutex<Option<ShortcutManager>>,
    shortcut_operations: Mutex<()>,
    shortcut_status: Mutex<ShortcutBackendStatus>,
    portal: Mutex<Option<portal::PortalController>>,
    status: Mutex<StatusEvent>,
}

impl AppState {
    fn new(
        settings: Settings,
        registered_hotkey: String,
        shortcut_manager: ShortcutManager,
    ) -> Self {
        let shortcut_status = shortcut_manager.status();
        Self {
            registered_hotkey: Mutex::new(registered_hotkey),
            shortcut_manager: Mutex::new(Some(shortcut_manager)),
            shortcut_operations: Mutex::new(()),
            shortcut_status: Mutex::new(shortcut_status),
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

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn installed_rule_matches(path: &Path) -> bool {
    std::fs::read(path)
        .map(|content| content == SHORTCUT_RULE.as_bytes())
        .unwrap_or(false)
}

#[cfg(unix)]
fn prepare_shortcut_rule(directory: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    std::fs::create_dir_all(directory)
        .map_err(|error| format!("cannot create permission setup directory: {error}"))?;
    let destination = directory.join(SHORTCUT_RULE_NAME);
    let temporary = directory.join(format!(".{SHORTCUT_RULE_NAME}.new"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true).mode(0o644);
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("cannot prepare permission rule: {error}"))?;
    use std::io::Write;
    file.write_all(SHORTCUT_RULE.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("cannot write permission rule: {error}"))?;
    std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o644))
        .map_err(|error| format!("cannot set permission rule mode: {error}"))?;
    std::fs::rename(&temporary, &destination)
        .map_err(|error| format!("cannot publish permission rule: {error}"))?;
    Ok(destination)
}

#[cfg(not(unix))]
fn prepare_shortcut_rule(_directory: &Path) -> Result<PathBuf, String> {
    Err("permission setup is supported only on Linux".into())
}

fn permission_setup_for_path(
    prepared: Option<&Path>,
    installed: bool,
    setup_error: Option<String>,
) -> ShortcutPermissionSetup {
    let prepared_rule_path = prepared.map(|path| path.to_string_lossy().into_owned());
    let mut install_commands = Vec::new();
    if let Some(path) = prepared {
        install_commands.push(format!(
            "sudo install -m 0644 {} {}",
            shell_quote(&path.to_string_lossy()),
            shell_quote(SHORTCUT_RULE_DESTINATION)
        ));
        install_commands.push("sudo udevadm control --reload-rules".into());
        install_commands.push("sudo udevadm trigger --subsystem-match=input --action=add".into());
    }
    ShortcutPermissionSetup {
        supported: cfg!(target_os = "linux"),
        disclosure: "Правило предоставляет активному графическому пользователю доступ к полным потокам событий клавиатуры: любой процесс этого пользователя сможет читать все нажатия. Помощник Slovo передаёт приложению только события Pressed/Released настроенного сочетания, но не является границей безопасности от других процессов того же пользователя.".into(),
        install_commands,
        revoke_commands: vec![
            format!("sudo rm -f {}", shell_quote(SHORTCUT_RULE_DESTINATION)),
            "sudo udevadm control --reload-rules".into(),
            "sudo udevadm trigger --subsystem-match=input --action=add".into(),
        ],
        destination: SHORTCUT_RULE_DESTINATION.into(),
        installed,
        prepared_rule_path,
        setup_error,
        note: "Команды выполняются только пользователем вручную. После установки или удаления может потребоваться переподключить клавиатуру или повторно войти в сеанс. Slovo не удаляет ACL других программ.".into(),
    }
}

#[cfg(target_os = "linux")]
fn permission_setup_in_directory(directory: &Path) -> Result<ShortcutPermissionSetup, String> {
    let prepared = prepare_shortcut_rule(&directory.join("permission-setup")).map_err(|error| {
        format!(
            "cannot prepare shortcut permission rule under {}: {error}",
            directory.display()
        )
    })?;
    Ok(permission_setup_for_path(
        Some(&prepared),
        installed_rule_matches(Path::new(SHORTCUT_RULE_DESTINATION)),
        None,
    ))
}

#[tauri::command]
fn get_shortcut_permission_setup(app: AppHandle) -> Result<ShortcutPermissionSetup, String> {
    #[cfg(target_os = "linux")]
    {
        // The bundled resource is intentionally resolved for diagnostics, while
        // include_str remains the canonical exact content in dev and bundles.
        let _bundled_rule = app
            .path()
            .resource_dir()
            .ok()
            .map(|directory| directory.join("resources").join(SHORTCUT_RULE_NAME));
        let directory = resolve_permission_setup_dir(&app);
        log_permission_setup_dir(&directory);
        let directory = directory.map_err(|error| {
            let detail = format!("cannot resolve shortcut permission directory: {error}");
            log_permission_setup_message(&detail);
            detail
        })?;
        let setup = permission_setup_in_directory(&directory).inspect_err(|detail| {
            log_permission_setup_message(detail);
        })?;
        if let Some(path) = setup.prepared_rule_path.as_deref() {
            log_permission_setup_message(&format!("prepared rule at {path}"));
        }
        Ok(setup)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(permission_setup_for_path(None, false, None))
    }
}

/// Resolves a stable, user-writable directory for the prepared udev rule.
///
/// Tauri's `app_config_dir()` is the canonical home on most systems
/// (`$XDG_CONFIG_HOME/com.slovo.app` or `~/.config/com.slovo.app`), but in some
/// dev/embedded configurations it returns `Err`. As a no-new-dependency fallback
/// we honor `XDG_CONFIG_HOME` / `HOME` manually and join the Tauri identifier,
/// matching the same `com.slovo.app` path the app uses elsewhere.
fn resolve_permission_setup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(directory) = app.path().app_config_dir() {
        return Ok(directory);
    }
    permission_setup_dir_from_env_only()
}

/// No-new-dependency fallback honored when Tauri cannot resolve the config dir.
/// Resolves `$XDG_CONFIG_HOME/com.slovo.app` or `$HOME/.config/com.slovo.app`,
/// matching `dirs::config_dir()` semantics joined with the Tauri identifier.
fn permission_setup_dir_from_env_only() -> Result<PathBuf, String> {
    let config_dir = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|home| home.join(".config"))
        })
        .ok_or_else(|| "neither XDG_CONFIG_HOME nor HOME is set".to_owned())?;
    Ok(config_dir.join("com.slovo.app"))
}

/// Emits a diagnostic line that survives both interactive and piped stderr by
/// flushing explicitly. Uses `[slovo]` so it can be grepped from the run log.
fn log_permission_setup_message(message: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "[slovo] {message}");
    let _ = std::io::stderr().flush();
}

fn log_permission_setup_dir(directory: &Result<PathBuf, String>) {
    match directory {
        Ok(path) => log_permission_setup_message(&format!(
            "shortcut permission setup directory resolved to {}",
            path.display()
        )),
        Err(error) => log_permission_setup_message(&format!(
            "shortcut permission setup directory could not be resolved: {error}"
        )),
    }
}

#[tauri::command]
fn get_shortcut_backend_status(
    state: State<'_, AppState>,
) -> Result<ShortcutBackendStatus, String> {
    state
        .shortcut_status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "shortcut status lock poisoned".into())
}

fn with_shortcut_manager<T>(
    state: &AppState,
    operation: impl FnOnce(&mut ShortcutManager) -> T,
) -> Result<T, String> {
    // The operation guard serializes mutations while the manager itself is moved
    // out of AppState. Blocking helper IPC therefore never holds the manager lock.
    // A re-entrant mutation sees the manager as busy and returns instead of deadlocking.
    let _operation = state
        .shortcut_operations
        .lock()
        .map_err(|_| "shortcut operation lock poisoned")?;
    let mut manager = state
        .shortcut_manager
        .lock()
        .map_err(|_| "shortcut manager lock poisoned")?
        .take()
        .ok_or("shortcut manager is busy")?;
    let result = operation(&mut manager);
    *state
        .shortcut_manager
        .lock()
        .map_err(|_| "shortcut manager lock poisoned")? = Some(manager);
    Ok(result)
}

#[tauri::command]
fn retry_shortcut_backend(app: AppHandle) -> Result<ShortcutBackendStatus, String> {
    let app_for_retry = app.clone();
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("slovo-shortcut-retry".into())
        .spawn(move || {
            let state = app_for_retry.state::<AppState>();
            let result = with_shortcut_manager(&state, |manager| {
                manager
                    .retry(&app_for_retry)
                    .map(|_| manager.status())
                    .map_err(|error| error.to_string())
            })
            .and_then(|result| result);
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

fn set_shortcut_status(app: &AppHandle, status: ShortcutBackendStatus) {
    if let Ok(mut current) = app.state::<AppState>().shortcut_status.lock() {
        *current = status.clone();
    }
    let _ = app.emit("slovo://shortcut-status", status);
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
    parse_hotkey(&next.hotkey)?;
    let new_chord = next
        .hotkey
        .parse::<ShortcutChord>()
        .map_err(|error| error.to_string())?;
    let state = app.state::<AppState>();
    let old_hotkey = state
        .registered_hotkey
        .lock()
        .map_err(|_| "hotkey lock poisoned")?
        .clone();

    let manager_kind = state
        .shortcut_status
        .lock()
        .map_err(|_| "shortcut status lock poisoned")?
        .backend();
    if next.hotkey != old_hotkey {
        if manager_kind == BackendKind::LegacyPortal {
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
            let result = with_shortcut_manager(&state, |manager| {
                let result = manager.replace(&app, new_chord);
                let status = manager.status();
                (result, status)
            })?;
            set_shortcut_status(&app, result.1);
            result.0.map_err(|error| error.to_string())?;
        }
    }

    if let Err(error) = settings::save(&app, &next) {
        if next.hotkey != old_hotkey && manager_kind != BackendKind::LegacyPortal {
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
            let registered_hotkey = match parse_hotkey(&settings.hotkey) {
                Ok(_) => canonicalize_hotkey(&settings.hotkey)?,
                Err(_) => {
                    parse_hotkey(settings::DEFAULT_HOTKEY)?;
                    settings::DEFAULT_HOTKEY.to_owned()
                }
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
            app.manage(AppState::new(
                settings.clone(),
                registered_hotkey.clone(),
                manager,
            ));
            eprintln!("[slovo] setup: AppState stored");
            if let Ok(status) = get_shortcut_backend_status(app.state::<AppState>()) {
                set_shortcut_status(app.handle(), status);
            }
            setup_tray(app.handle())?;

            if session == LinuxSession::Wayland && !helper_enabled {
                eprintln!("[slovo] session: wayland; starting legacy portal in background");
                let controller = portal::PortalController::new(
                    app.handle().clone(),
                    settings.hotkey.clone(),
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
            get_settings,
            update_settings,
            get_status,
            get_shortcut_backend_status,
            get_shortcut_permission_setup,
            retry_shortcut_backend,
            list_input_devices
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

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    #[test]
    fn permission_rule_content_and_commands_are_exact_and_safe() {
        assert_eq!(
            SHORTCUT_RULE,
            "# Slovo Wayland global hotkeys. SECURITY: grants the active graphical user\n# read access to complete keyboard event streams; every process of that user\n# can then read all keystrokes. Slovo filters locally to the configured chord.\nACTION==\"remove\", GOTO=\"slovo_input_end\"\nSUBSYSTEM==\"input\", KERNEL==\"event[0-9]*\", ENV{ID_INPUT_KEYBOARD}==\"1\", TAG+=\"uaccess\"\nLABEL=\"slovo_input_end\"\n"
        );
        let path = Path::new("/home/Test User/it's/rule file");
        let setup = permission_setup_for_path(Some(path), false, None);
        assert_eq!(
            setup.install_commands[0],
            "sudo install -m 0644 '/home/Test User/it'\\''s/rule file' '/usr/lib/udev/rules.d/72-slovo-input-helper.rules'"
        );
        assert_eq!(
            setup.install_commands[1],
            "sudo udevadm control --reload-rules"
        );
        assert_eq!(
            setup.install_commands[2],
            "sudo udevadm trigger --subsystem-match=input --action=add"
        );
        assert_eq!(
            setup.revoke_commands[0],
            "sudo rm -f '/usr/lib/udev/rules.d/72-slovo-input-helper.rules'"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn permission_setup_success_has_non_empty_commands_and_failure_is_surfaced() {
        let root = std::env::temp_dir().join(format!(
            "slovo-permission-setup-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let setup = permission_setup_in_directory(&root).unwrap();
        assert!(!setup.install_commands.is_empty());
        assert!(!setup.revoke_commands.is_empty());

        let blocker = root.join("blocker");
        std::fs::write(&blocker, "not a directory").unwrap();
        let error = permission_setup_in_directory(&blocker).unwrap_err();
        assert!(error.contains("cannot prepare shortcut permission rule"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn permission_setup_fallback_keeps_disclosure_and_serializes_static_error() {
        let setup = permission_setup_for_path(
            None,
            false,
            Some("Не удалось подготовить файл правила.".into()),
        );
        assert!(setup.install_commands.is_empty());
        assert!(setup.prepared_rule_path.is_none());
        assert!(!setup.disclosure.is_empty());
        assert_eq!(setup.revoke_commands.len(), 3);
        let value = serde_json::to_value(setup).unwrap();
        assert_eq!(value["setupError"], "Не удалось подготовить файл правила.");
        assert!(value["installCommands"].as_array().unwrap().is_empty());
        assert!(value["preparedRulePath"].is_null());
    }

    #[test]
    fn permission_setup_dir_fallback_uses_xdg_config_home_when_set() {
        // Force XDG_CONFIG_HOME to a known temp location and verify the manual
        // fallback joins it with com.slovo.app, matching Tauri's app_config_dir.
        let temp = std::env::temp_dir().join(format!("slovo-xdg-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).unwrap();
        let previous_xdg = std::env::var_os("XDG_CONFIG_HOME");
        std::env::set_var("XDG_CONFIG_HOME", &temp);
        let dir = permission_setup_dir_from_env_only().unwrap();
        assert_eq!(dir, temp.join("com.slovo.app"));
        if let Some(value) = previous_xdg {
            std::env::set_var("XDG_CONFIG_HOME", value);
        } else {
            std::env::remove_var("XDG_CONFIG_HOME");
        }
        std::fs::remove_dir_all(&temp).unwrap();
    }

    #[test]
    fn permission_diagnostics_flush_to_stderr_without_panicking() {
        // Confirms log_permission_setup_message reaches the stream as a flushed
        // `[slovo]` line and exercises both ok and err path formatters.
        log_permission_setup_message("diagnostic probe 1");
        log_permission_setup_dir(&Ok(PathBuf::from("/probe/path")));
        log_permission_setup_dir(&Err("probe failure".to_owned()));
    }

    #[test]
    fn installed_rule_requires_exact_content() {
        let directory = std::env::temp_dir().join(format!(
            "slovo-rule-test-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("unnamed")
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(SHORTCUT_RULE_NAME);
        std::fs::write(&path, SHORTCUT_RULE).unwrap();
        assert!(installed_rule_matches(&path));
        std::fs::write(&path, format!("{SHORTCUT_RULE}# modified\n")).unwrap();
        assert!(!installed_rule_matches(&path));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn prepared_rule_is_atomic_content_with_0644_mode() {
        use std::os::unix::fs::PermissionsExt;
        let directory =
            std::env::temp_dir().join(format!("slovo-prepare-rule-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let path = prepare_shortcut_rule(&directory).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SHORTCUT_RULE);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert!(!directory
            .join(format!(".{SHORTCUT_RULE_NAME}.new"))
            .exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

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
