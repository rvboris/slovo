//! Aggregate application state and the helpers that mutate it safely.
//!
//! The app keeps its mutable state behind a small number of `Mutex`es. Two of
//! those mutexes ([`AppState::settings`] and [`AppState::shortcut`]) wrap
//! *consolidated* runtime structs so that values always mutated together
//! cannot drift apart and so the lock-ordering surface is small and explicit.

use crate::audio::AudioController;
use crate::settings::Settings;
use crate::shortcut::{ShortcutBackendStatus, ShortcutManager};
use crate::trigger::TriggerState;
use num_traits::ToPrimitive;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Size, WebviewWindow,
    WebviewWindowBuilder,
};

/// Consolidated settings + registered hotkey string.
///
/// These two values are always mutated together in `update_settings`, so they
/// share a single mutex to make that atomic and to remove a lock-ordering
/// hazard.
pub(crate) struct SettingsRuntime {
    pub(crate) settings: Settings,
    pub(crate) registered_hotkey: String,
}

/// Consolidated shortcut backend runtime.
///
/// `manager` and `status` describe the same subsystem. `manager` is absent
/// while asynchronous Wayland initialization has not succeeded, and is also
/// temporarily `take`n during a serialized blocking operation. `status` remains
/// available in both cases and reflects the latest authoritative publication.
pub(crate) struct ShortcutRuntime {
    pub(crate) manager: Option<ShortcutManager>,
    pub(crate) status: ShortcutBackendStatus,
    /// Increments whenever a backend publishes status through the shared state.
    pub(crate) status_revision: u64,
}

/// Aggregate application state.
///
/// # Lock order
///
/// When multiple locks must be held simultaneously, acquire them in this order:
///   1. `SETTINGS_SAVE` (commands module)
///   2. `processing`
///   3. short `settings` / `recording` snapshots
///   4. `shortcut`, `trigger`, `status` only when their operation permits it
///
/// Never hold `processing` across `ShortcutManager::replace`: the Wayland
/// helper may synchronously dispatch a release while replacement waits for ACK.
/// Never hold `settings` while waiting for `processing`.
///
/// `shortcut_operations` is a plain `Mutex<()>` used purely as a serialization
/// primitive. Initialization, retry, replace, and shutdown manager mutations
/// hold it for their full duration. It must be acquired BEFORE `shortcut`
/// whenever both are needed; blocking helper IPC never holds `shortcut`.
/// `shortcut_stopping` is lock-free lifecycle state and may be checked at any
/// point, including while an operation owns `shortcut_operations`.
pub struct AppState {
    pub(crate) settings: Mutex<SettingsRuntime>,
    pub(crate) trigger: Mutex<TriggerState>,
    pub(crate) audio: AudioController,
    pub(crate) recording: Mutex<Option<Instant>>,
    // Serializes start/stop transitions; true blocks new jobs until output completes.
    pub(crate) processing: Mutex<bool>,
    /// Odd while a server check/start is pending; even otherwise.
    pub(crate) recording_start_token: AtomicU64,
    pub(crate) shortcut: Mutex<ShortcutRuntime>,
    pub(crate) shortcut_operations: Mutex<()>,
    pub(crate) shortcut_stopping: AtomicBool,
    /// Monotonic capture token packed as `(token << 1) | active`.
    /// A token prevents a delayed end command from disabling a newer capture.
    hotkey_capture: std::sync::atomic::AtomicU64,
    pub(crate) status: Mutex<StatusEvent>,
    status_revision: AtomicU64,
}

pub(crate) struct ProcessingReservation<'a> {
    processing: &'a Mutex<bool>,
}

impl Drop for ProcessingReservation<'_> {
    fn drop(&mut self) {
        if let Ok(mut processing) = self.processing.lock() { *processing = false; }
    }
}

impl AppState {
    pub(crate) fn reserve_idle_processing(&self) -> Result<ProcessingReservation<'_>, String> {
        let mut processing = self.processing.lock().map_err(|_| "processing lock poisoned")?;
        let recording = self.recording.lock().map_err(|_| "recording lock poisoned")?;
        if *processing || recording.is_some() || self.recording_start_token.load(Ordering::Acquire) & 1 == 1 {
            return Err("Cannot change the hotkey while recording or processing is active.".to_owned());
        }
        *processing = true;
        drop(recording);
        drop(processing);
        Ok(ProcessingReservation { processing: &self.processing })
    }

    pub(crate) fn set_hotkey_capture(&self, active: bool, token: u64) -> Result<(), String> {
        if !active {
            self.update_hotkey_capture(active, token);
            return Ok(());
        }

        let processing = self.processing.lock().map_err(|_| "processing lock poisoned")?;
        let mut current = self.hotkey_capture.load(Ordering::Acquire);
        let result = loop {
            if token < (current >> 1) { break Ok(()); }
            if *processing {
                break Err("Cannot capture a hotkey while processing is active.".to_owned());
            }
            if self.recording.lock().map_err(|_| "recording lock poisoned")?.is_some() {
                break Err("Cannot capture a hotkey while recording is active.".to_owned());
            }
            if self.recording_start_token.load(Ordering::Acquire) & 1 == 1 {
                break Err("Cannot capture a hotkey while recording is starting.".to_owned());
            }
            let next = (token << 1) | 1;
            match self.hotkey_capture.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break Ok(()),
                Err(observed) => current = observed,
            }
        };
        drop(processing);
        result
    }

    fn update_hotkey_capture(&self, active: bool, token: u64) {
        let next = (token << 1) | u64::from(active);
        let mut current = self.hotkey_capture.load(Ordering::Acquire);
        while token >= (current >> 1) {
            match self.hotkey_capture.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(observed) => current = observed,
            }
        }
    }

    pub(crate) fn is_hotkey_capture_active(&self) -> bool {
        self.hotkey_capture.load(Ordering::Acquire) & 1 == 1
    }

    pub(crate) fn begin_recording_start(&self) -> Option<u64> {
        let current = self.recording_start_token.load(Ordering::Acquire);
        if current & 1 == 1 {
            return None;
        }
        let token = current.wrapping_add(1);
        self.recording_start_token
            .compare_exchange(current, token, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| token)
    }

    pub(crate) fn recording_start_is_current(&self, token: u64) -> bool {
        self.recording_start_token.load(Ordering::Acquire) == token
    }

    pub(crate) fn finish_recording_start(&self, token: u64) -> bool {
        self.recording_start_token
            .compare_exchange(
                token,
                token.wrapping_add(1),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub(crate) fn cancel_recording_start(&self) {
        let mut current = self.recording_start_token.load(Ordering::Acquire);
        while current & 1 == 1 {
            match self.recording_start_token.compare_exchange_weak(
                current,
                current.wrapping_add(1),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(observed) => current = observed,
            }
        }
    }

    pub(crate) fn new(
        settings: Settings,
        registered_hotkey: String,
        shortcut_manager: Option<ShortcutManager>,
        shortcut_status: ShortcutBackendStatus,
    ) -> Self {
        Self {
            settings: Mutex::new(SettingsRuntime {
                settings,
                registered_hotkey,
            }),
            trigger: Mutex::new(TriggerState::default()),
            audio: AudioController::new(),
            recording: Mutex::new(None),
            processing: Mutex::new(false),
            recording_start_token: AtomicU64::new(0),
            shortcut: Mutex::new(ShortcutRuntime {
                manager: shortcut_manager,
                status: shortcut_status,
                status_revision: 0,
            }),
            shortcut_operations: Mutex::new(()),
            shortcut_stopping: AtomicBool::new(false),
            hotkey_capture: std::sync::atomic::AtomicU64::new(0),
            status_revision: AtomicU64::new(0),
            status: Mutex::new(StatusEvent {
                kind: StatusKind::Ready,
                revision: 0,
                message: None,
                correction_warning: None,
                elapsed_seconds: None,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StatusKind {
    Ready,
    Recording,
    Transcribing,
    Correcting,
    Error,
    Copied,
    Inserted,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct StatusEvent {
    pub(crate) kind: StatusKind,
    pub(crate) revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
    #[serde(rename = "correctionWarning", skip_serializing_if = "Option::is_none")]
    pub(crate) correction_warning: Option<String>,
    #[serde(rename = "elapsedSeconds", skip_serializing_if = "Option::is_none")]
    pub(crate) elapsed_seconds: Option<u64>,
}

pub(crate) fn emit_status(app: &AppHandle, kind: StatusKind, message: Option<String>) {
    emit_status_event(
        app,
        StatusEvent {
            kind,
            revision: 0,
            message,
            correction_warning: None,
            elapsed_seconds: None,
        },
    );
}

pub(crate) fn emit_status_event(app: &AppHandle, event: StatusEvent) {
    let state = app.state::<AppState>();
    let published = {
        let Ok(mut current) = state.status.lock() else { return; };
        publish_status_locked(&mut current, &state.status_revision, event, |published| {
            if let Err(error) = app.emit("slovo://status", published.clone()) {
                eprintln!("[slovo] cannot emit status event: {error}");
            }
        })
    };
    queue_status_window_action(app, published.clone(), published.revision);
}

fn publish_status_locked(
    snapshot: &mut StatusEvent,
    revision: &AtomicU64,
    mut event: StatusEvent,
    mut publish: impl FnMut(&StatusEvent),
) -> StatusEvent {
    event.revision = revision.fetch_add(1, Ordering::AcqRel) + 1;
    *snapshot = event.clone();
    publish(&event);
    event
}

fn with_current_status_revision<T>(
    status: &Mutex<StatusEvent>,
    expected: u64,
    action: impl FnOnce() -> T,
) -> Option<T> {
    let current = status.lock().ok()?;
    (current.revision == expected).then(action)
}

fn queue_status_window_action(app: &AppHandle, event: StatusEvent, revision: u64) {
    let queued_app = app.clone();
    if app.run_on_main_thread(move || {
        let app = queued_app;
        let state = app.state::<AppState>();
        let presentation = status_presentation(&event.kind);
        let current = with_current_status_revision(&state.status, revision, || {
            manage_recording_overlay(&app, &event);
        });
        if current.is_some() && presentation.delay_hide {
            queue_overlay_hide(app.clone(), revision);
        }
    }).is_err() {
        eprintln!("[slovo] could not queue status presentation");
    }
}

fn queue_overlay_hide(app: AppHandle, revision: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        let queued_app = app.clone();
        if app.run_on_main_thread(move || {
            let app = queued_app;
            let state = app.state::<AppState>();
            with_current_status_revision(&state.status, revision, || {
                if let Some(window) = app.get_webview_window("recording-overlay") {
                    if let Err(error) = hide_recording_overlay(&window) {
                        eprintln!("[slovo] recording overlay error: {error}");
                    }
                }
            });
        }).is_err() {
            eprintln!("[slovo] could not queue overlay hide");
        }
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StatusPresentation { show: bool, delay_hide: bool }

fn status_presentation(kind: &StatusKind) -> StatusPresentation {
    match kind {
        StatusKind::Recording | StatusKind::Transcribing | StatusKind::Correcting => StatusPresentation { show: true, delay_hide: false },
        StatusKind::Inserted | StatusKind::Copied | StatusKind::Error => StatusPresentation { show: true, delay_hide: true },
        StatusKind::Ready => StatusPresentation { show: false, delay_hide: false },
    }
}

fn manage_recording_overlay(app: &AppHandle, event: &StatusEvent) {
    let result = if status_presentation(&event.kind).show {
        get_or_create_recording_overlay(app).and_then(|window| show_recording_overlay(&window))
    } else {
        app.get_webview_window("recording-overlay")
            .map_or(Ok(()), |window| hide_recording_overlay(&window))
    };
    if let Err(error) = result {
        eprintln!("[slovo] recording overlay error: {error}");
    }
}

fn get_or_create_recording_overlay(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("recording-overlay") {
        return Ok(window);
    }

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "recording-overlay")
        .ok_or_else(|| "recording overlay config not found".to_owned())?;

    WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| format!("cannot configure recording overlay: {error}"))?
        .visible(false)
        .focusable(false)
        .build()
        .map_err(|error| format!("cannot build recording overlay: {error}"))
}

fn show_recording_overlay(window: &WebviewWindow) -> Result<(), String> {
    const OVERLAY_W: f64 = 172.0;
    const OVERLAY_H: f64 = 48.0;

    // Do not trust a compositor-restored/default geometry: the card fills this
    // surface, so a stale square window turns the rounded card into a huge disk.
    window
        .set_size(Size::Logical(LogicalSize::new(OVERLAY_W, OVERLAY_H)))
        .map_err(|error| format!("cannot size recording overlay: {error}"))?;

    // Position computation is harmless on X11; on GNOME/Mutter (Wayland) the
    // compositor places the surface itself and `set_position` is a no-op.
    if let Some(monitor) = window
        .primary_monitor()
        .map_err(|error| format!("cannot get primary monitor: {error}"))?
    {
        let monitor_size = monitor.size();
        let monitor_position = monitor.position();
        // Use the requested logical size scaled to physical pixels instead of
        // querying outer_size(): on XWayland the previous set_size may not have
        // taken effect yet, so outer_size() returns the stale default geometry
        // and the first-show position ends up shifted.
        let scale = monitor.scale_factor();
        let window_w = (OVERLAY_W * scale)
            .round()
            .to_i32()
            .ok_or_else(|| "recording overlay width exceeds supported range".to_owned())?;
        let window_h = (OVERLAY_H * scale)
            .round()
            .to_i32()
            .ok_or_else(|| "recording overlay height exceeds supported range".to_owned())?;
        let monitor_w = i32::try_from(monitor_size.width)
            .map_err(|_| "primary monitor width exceeds supported range".to_owned())?;
        let monitor_h = i32::try_from(monitor_size.height)
            .map_err(|_| "primary monitor height exceeds supported range".to_owned())?;
        let bottom_margin = (28.0 * scale)
            .round()
            .to_i32()
            .ok_or_else(|| "recording overlay margin exceeds supported range".to_owned())?;
        let x = monitor_position.x + (monitor_w - window_w) / 2;
        let y = monitor_position.y + monitor_h - window_h - bottom_margin;
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
    Ok(())
}

fn hide_recording_overlay(window: &WebviewWindow) -> Result<(), String> {
    window
        .hide()
        .map_err(|error| format!("cannot hide recording overlay: {error}"))
}

/// RAII guard that restores the [`ShortcutManager`] into [`ShortcutRuntime`]
/// when dropped.  This prevents the manager from being permanently lost if the
/// operation panics or returns early.
struct ManagerGuard<'a> {
    shortcut: &'a Mutex<ShortcutRuntime>,
    manager: Option<ShortcutManager>,
}

impl ManagerGuard<'_> {
    /// Returns a mutable reference to the extracted manager.
    fn manager_mut(&mut self) -> &mut ShortcutManager {
        self.manager
            .as_mut()
            .expect("ManagerGuard manager consumed before drop")
    }
}

impl Drop for ManagerGuard<'_> {
    fn drop(&mut self) {
        if let Some(manager) = self.manager.take() {
            // Best-effort restore; if the mutex is poisoned the manager is
            // abandoned, but that state already implies an unrecoverable panic.
            if let Ok(mut runtime) = self.shortcut.lock() {
                runtime.status = manager.status();
                runtime.manager = Some(manager);
            }
        }
    }
}

/// Runs `operation` against the live [`ShortcutManager`] while guaranteeing
/// that neither `set_shared_status` (called by Wayland helper methods) nor the
/// protocol reader thread can deadlock on `state.shortcut`.
///
/// # Design
///
/// The manager is **taken** out of [`ShortcutRuntime`] under `shortcut` lock,
/// after which the lock is dropped.  The operation then runs free of the
/// `shortcut` mutex — so any internal status publication
/// (`set_shared_status`) or channel wait (`wait_for`) cannot cause a
/// self-deadlock or circular wait with the reader thread.
///
/// A [`ManagerGuard`] restores the manager and refreshes the cached status on
/// drop (including on panic/early-return), so readers always see a consistent
/// runtime.
///
/// `shortcut_operations` is still acquired first as a serialization primitive,
/// ensuring a second caller cannot observe the temporarily empty manager slot.
pub(crate) fn with_shortcut_manager<T>(
    state: &AppState,
    operation: impl FnOnce(&mut ShortcutManager) -> T,
) -> Result<T, String> {
    with_extracted_shortcut_manager(&state.shortcut, &state.shortcut_operations, operation)
}

/// Constructs, configures, and installs a missing manager as one serialized
/// operation. Construction and configuration run without the `shortcut` lock,
/// because the Wayland helper publishes status through that same mutex.
pub(crate) fn initialize_shortcut_manager(
    state: &AppState,
    backend: crate::shortcut::BackendKind,
    construct: impl FnOnce() -> Result<ShortcutManager, String>,
    configure: impl FnOnce(&mut ShortcutManager) -> Result<(), String>,
) -> Result<ShortcutBackendStatus, String> {
    let _operation = state
        .shortcut_operations
        .lock()
        .map_err(|_| "shortcut operation lock poisoned")?;
    initialize_shortcut_manager_locked(state, backend, construct, configure)
}

fn initialize_shortcut_manager_locked(
    state: &AppState,
    backend: crate::shortcut::BackendKind,
    construct: impl FnOnce() -> Result<ShortcutManager, String>,
    configure: impl FnOnce(&mut ShortcutManager) -> Result<(), String>,
) -> Result<ShortcutBackendStatus, String> {
    let (status_revision_before_construct, status_before_construct) = {
        let runtime = state
            .shortcut
            .lock()
            .map_err(|_| "shortcut lock poisoned")?;
        if runtime.manager.is_some() {
            return Ok(runtime.status.clone());
        }
        if state.shortcut_stopping.load(Ordering::Acquire) {
            return Err("shortcut backend is shutting down".to_owned());
        }
        (runtime.status_revision, runtime.status.clone())
    };

    let mut manager = match construct() {
        Ok(manager) => manager,
        Err(error) => {
            let shortcut = &state.shortcut;
            let mut runtime = shortcut.lock().map_err(|_| "shortcut lock poisoned")?;
            if state.shortcut_stopping.load(Ordering::Acquire) {
                return Err("shortcut backend is shutting down".to_owned());
            }
            let actionable_status_was_published = runtime.status_revision
                != status_revision_before_construct
                && runtime.status != status_before_construct
                && matches!(
                    &runtime.status,
                    ShortcutBackendStatus::PermissionDenied { .. }
                        | ShortcutBackendStatus::DevicesUnavailable { .. }
                );
            if !actionable_status_was_published {
                runtime.status = ShortcutBackendStatus::Failed {
                    backend,
                    detail: error.clone(),
                };
            }
            drop(runtime);
            return Err(error);
        }
    };

    if let Err(error) = configure(&mut manager) {
        let manager_status = manager.status();
        let shortcut = &state.shortcut;
        let mut runtime = shortcut.lock().map_err(|_| "shortcut lock poisoned")?;
        if state.shortcut_stopping.load(Ordering::Acquire) {
            manager.invalidate();
            return Err("shortcut backend is shutting down".to_owned());
        }
        runtime.status = match manager_status {
            status @ (ShortcutBackendStatus::PermissionDenied { .. }
            | ShortcutBackendStatus::DevicesUnavailable { .. }) => status,
            _ => ShortcutBackendStatus::Failed {
                backend,
                detail: error.clone(),
            },
        };
        drop(runtime);
        return Err(error);
    }

    let manager_status = manager.status();
    let shortcut = &state.shortcut;
    let mut runtime = shortcut.lock().map_err(|_| "shortcut lock poisoned")?;
    if state.shortcut_stopping.load(Ordering::Acquire) {
        manager.invalidate();
        runtime.status = ShortcutBackendStatus::ShuttingDown;
        drop(runtime);
        return Err("shortcut backend is shutting down".to_owned());
    }
    let status_was_newly_published = runtime.status_revision != status_revision_before_construct
        && runtime.status != status_before_construct;
    let status = if status_was_newly_published
        && matches!(
            &runtime.status,
            ShortcutBackendStatus::PermissionDenied { .. }
                | ShortcutBackendStatus::DevicesUnavailable { .. }
                | ShortcutBackendStatus::Failed { .. }
        ) {
        runtime.status.clone()
    } else {
        manager_status
    };
    // The operations lock makes this assignment atomic with the absence check.
    runtime.manager = Some(manager);
    runtime.status = status.clone();
    drop(runtime);
    Ok(status)
}

/// Under one operation lock, retries an installed manager or initializes the
/// missing Wayland manager. Callers never infer absence while another operation
/// has temporarily extracted the manager.
pub(crate) fn retry_or_initialize_shortcut_manager(
    state: &AppState,
    backend: crate::shortcut::BackendKind,
    retry: impl FnOnce(&mut ShortcutManager) -> Result<(), String>,
    construct: impl FnOnce() -> Result<ShortcutManager, String>,
    configure: impl FnOnce(&mut ShortcutManager) -> Result<(), String>,
) -> Result<ShortcutBackendStatus, String> {
    let _operation = state
        .shortcut_operations
        .lock()
        .map_err(|_| "shortcut operation lock poisoned")?;
    if state.shortcut_stopping.load(Ordering::Acquire) {
        return Err("shortcut backend is shutting down".to_owned());
    }

    let manager = state
        .shortcut
        .lock()
        .map_err(|_| "shortcut lock poisoned")?
        .manager
        .take();
    if let Some(manager) = manager {
        let mut guard = ManagerGuard {
            shortcut: &state.shortcut,
            manager: Some(manager),
        };
        let result = retry(guard.manager_mut());
        if state.shortcut_stopping.load(Ordering::Acquire) {
            // Prevent ManagerGuard::drop from reinstalling this manager.
            if let Some(manager) = guard.manager.take() {
                manager.invalidate();
            }
            return Err("shortcut backend is shutting down".to_owned());
        }
        result?;
        return Ok(guard.manager_mut().status());
    }

    initialize_shortcut_manager_locked(state, backend, construct, configure)
}

/// Marks shutdown immediately, then serializes extraction and shutdown of an
/// installed manager. It is intended to run on a worker so an in-flight helper
/// handshake never blocks the event loop.
pub(crate) fn shutdown_shortcut_manager(
    state: &AppState,
    shutdown: impl FnOnce(&mut ShortcutManager) -> Result<(), String>,
) -> Result<(), String> {
    state.shortcut_stopping.store(true, Ordering::Release);
    let _operation = state
        .shortcut_operations
        .lock()
        .map_err(|_| "shortcut operation lock poisoned")?;
    let manager = state
        .shortcut
        .lock()
        .map_err(|_| "shortcut lock poisoned")?
        .manager
        .take();
    if let Some(mut manager) = manager {
        manager.invalidate();
        shutdown(&mut manager)?;
    }
    Ok(())
}

fn with_extracted_shortcut_manager<T>(
    shortcut: &Mutex<ShortcutRuntime>,
    shortcut_operations: &Mutex<()>,
    operation: impl FnOnce(&mut ShortcutManager) -> T,
) -> Result<T, String> {
    let _operation = shortcut_operations
        .lock()
        .map_err(|_| "shortcut operation lock poisoned")?;
    let mut runtime = shortcut.lock().map_err(|_| "shortcut lock poisoned")?;
    let manager = runtime
        .manager
        .take()
        .ok_or("shortcut manager is not initialized")?;
    drop(runtime);
    // The operation runs without holding `shortcut`.
    let mut guard = ManagerGuard {
        shortcut,
        manager: Some(manager),
    };
    let result = operation(guard.manager_mut());
    // ManagerGuard::drop restores the manager and updates the cached status.
    Ok(result)
}

pub(crate) fn set_shortcut_status(app: &AppHandle, status: ShortcutBackendStatus) {
    let state = app.state::<AppState>();
    let stopping = state.shortcut_stopping.load(Ordering::Acquire);
    if stopping && !matches!(status, ShortcutBackendStatus::ShuttingDown) {
        return;
    }
    if let Ok(mut shortcut) = state.shortcut.lock() {
        // Redundant check under lock to avoid racing the transition to ShuttingDown
        if state.shortcut_stopping.load(Ordering::Acquire)
            && !matches!(status, ShortcutBackendStatus::ShuttingDown)
        {
            return;
        }
        shortcut.status = status.clone();
        shortcut.status_revision = shortcut.status_revision.wrapping_add(1);
    }
    let _ = app.emit("slovo://shortcut-status", status);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status_event(kind: StatusKind) -> StatusEvent {
        StatusEvent { kind, revision: 0, message: None, correction_warning: None, elapsed_seconds: None }
    }

    #[test]
    fn status_publications_are_monotonic_and_update_snapshot() {
        let mut snapshot = status_event(StatusKind::Ready);
        let revision = AtomicU64::new(0);
        let mut delivered = Vec::new();
        for kind in [StatusKind::Error, StatusKind::Recording] {
            let event = publish_status_locked(&mut snapshot, &revision, status_event(kind), |event| delivered.push(event.clone()));
            assert_eq!(event.revision, delivered.len() as u64);
            assert_eq!(snapshot.revision, event.revision);
            assert!(std::mem::discriminant(&snapshot.kind) == std::mem::discriminant(&event.kind));
        }
        assert_eq!(delivered.len(), 2);
        assert!(matches!(delivered[0].kind, StatusKind::Error));
        assert!(matches!(delivered[1].kind, StatusKind::Recording));
    }

    #[test]
    fn status_presentation_classifies_all_kinds() {
        for (kind, show, delay_hide) in [
            (StatusKind::Recording, true, false), (StatusKind::Transcribing, true, false),
            (StatusKind::Correcting, true, false), (StatusKind::Inserted, true, true),
            (StatusKind::Copied, true, true), (StatusKind::Error, true, true),
            (StatusKind::Ready, false, false),
        ] {
            assert_eq!(status_presentation(&kind), StatusPresentation { show, delay_hide });
        }
    }

    #[test]
    fn delayed_hide_requires_matching_revision_and_does_not_mutate_snapshot() {
        let mut snapshot = status_event(StatusKind::Ready);
        let revision = AtomicU64::new(0);
        let terminal = publish_status_locked(&mut snapshot, &revision, StatusEvent { message: Some("done".into()), correction_warning: Some("warning".into()), ..status_event(StatusKind::Error) }, |_| {});
        let before = serde_json::to_value(&snapshot).unwrap();
        let hidden = std::cell::Cell::new(0);
        let status = Mutex::new(snapshot);
        let pending_hide = || { with_current_status_revision(&status, terminal.revision, || hidden.set(hidden.get() + 1)); };
        publish_status_locked(&mut status.lock().unwrap(), &revision, status_event(StatusKind::Recording), |_| {});
        pending_hide();
        assert_eq!(hidden.get(), 0);
        let mut matching_snapshot = status_event(StatusKind::Ready);
        let matching_terminal = publish_status_locked(&mut matching_snapshot, &AtomicU64::new(terminal.revision - 1), terminal.clone(), |_| {});
        let matching_status = Mutex::new(matching_snapshot);
        let matching_before = serde_json::to_value(&*matching_status.lock().unwrap()).unwrap();
        with_current_status_revision(&matching_status, matching_terminal.revision, || hidden.set(hidden.get() + 1));
        assert_eq!(hidden.get(), 1);
        assert_eq!(serde_json::to_value(&*matching_status.lock().unwrap()).unwrap(), matching_before);
        assert_eq!(before, matching_before);
    }

    #[test]
    fn status_serialization_uses_camel_case_and_omits_empty_fields() {
        let value = serde_json::to_value(StatusEvent { correction_warning: Some("warning".into()), ..status_event(StatusKind::Correcting) }).unwrap();
        assert_eq!(value["correctionWarning"], "warning");
        assert!(value.get("elapsedSeconds").is_none());
        assert!(value.get("message").is_none());
    }

    #[test]
    fn stale_queued_revision_does_not_run_action() {
        let status = Mutex::new(status_event(StatusKind::Error));
        let revision = status.lock().unwrap().revision;
        let ran = std::cell::Cell::new(false);
        *status.lock().unwrap() = StatusEvent { revision: revision + 1, ..status_event(StatusKind::Recording) };
        assert_eq!(with_current_status_revision(&status, revision, || ran.set(true)), None);
        assert!(!ran.get());
        assert_eq!(with_current_status_revision(&status, revision + 1, || ran.set(true)), Some(()));
        assert!(ran.get());
        assert_eq!(status.lock().unwrap().revision, revision + 1);
    }

    fn shortcut_runtime() -> Mutex<ShortcutRuntime> {
        Mutex::new(ShortcutRuntime {
            manager: Some(ShortcutManager::native()),
            status: ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native,
            },
            status_revision: 0,
        })
    }

    #[test]
    fn manager_operation_releases_shortcut_lock_and_restores_manager_on_ok() {
        let shortcut = shortcut_runtime();
        let operations = Mutex::new(());

        let result = with_extracted_shortcut_manager(&shortcut, &operations, |_| {
            // Models WaylandSupervisor::set_status publishing into AppState
            // while replace/retry owns the extracted manager.
            let mut runtime = shortcut
                .try_lock()
                .expect("operation must not hold shortcut lock");
            runtime.status = ShortcutBackendStatus::Restarting {
                backend: crate::shortcut::BackendKind::Native,
            };
            drop(runtime);
            Ok::<_, &'static str>(())
        })
        .expect("state operation should run");

        assert_eq!(result, Ok(()));
        assert!(shortcut.lock().unwrap().manager.is_some());
    }

    #[test]
    fn manager_operation_releases_shortcut_lock_and_restores_manager_on_err() {
        let shortcut = shortcut_runtime();
        let operations = Mutex::new(());

        let result = with_extracted_shortcut_manager(&shortcut, &operations, |_| {
            let _runtime = shortcut
                .try_lock()
                .expect("operation must not hold shortcut lock");
            Err::<(), _>("operation failed")
        })
        .expect("state operation should run");

        assert_eq!(result, Err("operation failed"));
        assert!(shortcut.lock().unwrap().manager.is_some());
    }

    fn test_state() -> AppState {
        AppState::new(
            crate::settings::Settings::default(),
            "Control+Shift+Space".to_owned(),
            None,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::WaylandHelper,
            },
        )
    }

    #[test]
    fn recording_start_allows_one_pending_check_and_can_cancel_it() {
        let state = test_state();
        let token = state.begin_recording_start().expect("first check starts");

        assert!(state.begin_recording_start().is_none());
        assert!(state.recording_start_is_current(token));

        state.cancel_recording_start();
        assert!(!state.recording_start_is_current(token));
        assert!(!state.finish_recording_start(token));
        assert!(state.begin_recording_start().is_some());
    }

    #[test]
    fn recording_start_token_can_be_finished_once() {
        let state = test_state();
        let token = state.begin_recording_start().expect("check starts");

        assert!(state.finish_recording_start(token));
        assert!(!state.finish_recording_start(token));
        assert!(state.begin_recording_start().is_some());
    }

    #[test]
    fn hotkey_capture_ignores_stale_commands() {
        let state = test_state();

        state.set_hotkey_capture(true, 1).unwrap();
        assert!(state.is_hotkey_capture_active());

        state.set_hotkey_capture(false, 2).unwrap();
        assert!(!state.is_hotkey_capture_active());

        state.set_hotkey_capture(true, 1).unwrap();
        assert!(!state.is_hotkey_capture_active());
    }

    #[test]
    fn capture_rejects_processing_and_pending_start_but_release_is_allowed() {
        let state = test_state();
        *state.processing.lock().unwrap() = true;
        assert!(state.set_hotkey_capture(true, 1).is_err());
        assert!(!state.is_hotkey_capture_active(), "rejected capture must not activate");
        assert!(state.set_hotkey_capture(false, 1).is_ok());
        *state.processing.lock().unwrap() = false;

        let start = state.begin_recording_start().expect("start reservation");
        assert!(state.set_hotkey_capture(true, 2).is_err());
        assert!(state.set_hotkey_capture(false, 2).is_ok());
        assert!(state.finish_recording_start(start));
    }

    #[test]
    fn reservation_excludes_capture_and_rolls_back_on_drop() {
        let state = test_state();
        {
            let reservation = state.reserve_idle_processing().expect("idle reservation");
            assert!(state.set_hotkey_capture(true, 1).is_err());
            drop(reservation);
        }
        assert!(state.set_hotkey_capture(true, 1).is_ok());
    }

    #[test]
    fn stale_activation_while_busy_is_a_noop() {
        let state = test_state();
        state.set_hotkey_capture(true, 2).unwrap();
        state.set_hotkey_capture(false, 2).unwrap();
        *state.processing.lock().unwrap() = true;

        assert!(state.set_hotkey_capture(true, 1).is_ok());
        assert!(!state.is_hotkey_capture_active());
    }

    #[test]
    fn newer_capture_is_not_cleared_by_older_end() {
        let state = test_state();

        state.set_hotkey_capture(true, 3).unwrap();
        state.set_hotkey_capture(false, 2).unwrap();

        assert!(state.is_hotkey_capture_active());
    }

    #[test]
    fn initialize_succeeds_and_installs_manager() {
        let state = test_state();
        let status = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        assert_eq!(
            status,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            }
        );
        assert!(state.shortcut.lock().unwrap().manager.is_some());
    }

    #[test]
    fn initialize_construction_failure_leaves_manager_absent() {
        let state = test_state();
        let result = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::WaylandHelper,
            || Err("spawn failed".to_owned()),
            |_| unreachable!("configure should not run"),
        );
        assert_eq!(result, Err("spawn failed".to_owned()));
        let runtime = state.shortcut.lock().unwrap();
        assert!(runtime.manager.is_none());
        assert_eq!(
            runtime.status,
            ShortcutBackendStatus::Failed {
                backend: crate::shortcut::BackendKind::WaylandHelper,
                detail: "spawn failed".to_owned(),
            }
        );
        drop(runtime);
    }

    #[test]
    fn initialize_is_idempotent_when_manager_is_installed() {
        let state = test_state();
        initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        let result = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::WaylandHelper,
            || panic!("second construction must not run"),
            |_| panic!("second configuration must not run"),
        );
        assert_eq!(
            result,
            Ok(ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            })
        );
    }

    #[test]
    fn initialize_aborts_before_construction_after_shutdown() {
        let state = test_state();
        state.shortcut_stopping.store(true, Ordering::Release);
        let result = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::WaylandHelper,
            || panic!("construction must not run after shutdown"),
            |_| unreachable!(),
        );
        assert_eq!(result, Err("shortcut backend is shutting down".to_owned()));
        assert!(state.shortcut.lock().unwrap().manager.is_none());
    }

    #[test]
    fn initialize_does_not_install_when_shutdown_starts_during_construction() {
        let state = test_state();
        let result = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || {
                state.shortcut_stopping.store(true, Ordering::Release);
                Ok(ShortcutManager::native())
            },
            |_| Ok(()),
        );
        assert_eq!(result, Err("shortcut backend is shutting down".to_owned()));
        let runtime = state.shortcut.lock().unwrap();
        assert!(runtime.manager.is_none());
        assert_eq!(runtime.status, ShortcutBackendStatus::ShuttingDown);
        drop(runtime);
    }

    #[test]
    fn initialization_does_not_hold_shortcut_lock() {
        let state = test_state();
        initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || {
                let runtime = state
                    .shortcut
                    .try_lock()
                    .expect("construction must not hold shortcut lock");
                assert!(runtime.manager.is_none());
                drop(runtime);
                Ok(ShortcutManager::native())
            },
            |manager| {
                let runtime = state
                    .shortcut
                    .try_lock()
                    .expect("configuration must not hold shortcut lock");
                assert!(runtime.manager.is_none());
                drop(runtime);
                manager.invalidate();
                Ok(())
            },
        )
        .expect("initialization should succeed");
        assert!(state.shortcut.lock().unwrap().manager.is_some());
    }

    #[test]
    fn retry_or_initialize_retries_installed_manager_without_construction() {
        let state = test_state();
        initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        let status = retry_or_initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            |_| Ok(()),
            || panic!("retry with installed manager must not construct"),
            |_| unreachable!(),
        )
        .expect("retry should succeed");
        assert_eq!(
            status,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            }
        );
        assert!(state.shortcut.lock().unwrap().manager.is_some());
    }

    #[test]
    fn retry_or_initialize_constructs_missing_manager() {
        let state = test_state();
        let status = retry_or_initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            |_| unreachable!("missing manager must not use existing retry"),
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        assert_eq!(
            status,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            }
        );
        assert!(state.shortcut.lock().unwrap().manager.is_some());
    }

    #[test]
    fn shutdown_without_manager_is_benign() {
        let state = test_state();
        let result = shutdown_shortcut_manager(&state, |_| panic!("no manager to shut down"));
        assert_eq!(result, Ok(()));
        assert!(state.shortcut_stopping.load(Ordering::Acquire));
        assert!(state.shortcut.lock().unwrap().manager.is_none());
    }

    #[test]
    fn initialize_after_prior_actionable_failure_uses_new_manager_status() {
        let state = test_state();
        {
            let mut runtime = state.shortcut.lock().unwrap();
            runtime.status = ShortcutBackendStatus::PermissionDenied {
                detail: "no access".to_owned(),
                setup_available: true,
            };
        }
        let status = initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        // The new manager's own status (Starting) must win, not the stale
        // PermissionDenied from the previous failed attempt.
        assert_eq!(
            status,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            }
        );
        let runtime = state.shortcut.lock().unwrap();
        assert_eq!(
            runtime.status,
            ShortcutBackendStatus::Starting {
                backend: crate::shortcut::BackendKind::Native
            }
        );
        assert!(runtime.manager.is_some());
        drop(runtime);
    }

    #[test]
    fn retry_does_not_reinstall_manager_after_shutdown_begins() {
        let state = test_state();
        initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            || Ok(ShortcutManager::native()),
            |_| Ok(()),
        )
        .expect("initialization should succeed");
        let result = retry_or_initialize_shortcut_manager(
            &state,
            crate::shortcut::BackendKind::Native,
            |_| {
                state.shortcut_stopping.store(true, Ordering::Release);
                Ok(())
            },
            || panic!("shutdown must not construct a new manager"),
            |_| unreachable!(),
        );
        assert_eq!(result, Err("shortcut backend is shutting down".to_owned()));
        assert!(state.shortcut.lock().unwrap().manager.is_none());
    }
}
