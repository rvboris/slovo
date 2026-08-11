mod native;
#[cfg(target_os = "linux")]
mod wayland;

pub use native::NativeShortcutBackend;
pub use slovo_shortcut_core::chord::{ShortcutChord, ShortcutError};

/// Shortcut implementation selected by the runtime environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendKind {
    Native,
    WaylandHelper,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ShortcutBackendStatus {
    Starting {
        backend: BackendKind,
    },
    Active {
        backend: BackendKind,
        shortcut: String,
        #[serde(rename = "deviceCount", skip_serializing_if = "Option::is_none")]
        device_count: Option<usize>,
    },
    PermissionDenied {
        detail: String,
        #[serde(rename = "setupAvailable")]
        setup_available: bool,
    },
    DevicesUnavailable {
        detail: String,
    },
    Restarting {
        backend: BackendKind,
    },
    Failed {
        backend: BackendKind,
        detail: String,
    },
    ShuttingDown,
}

impl ShortcutBackendStatus {
    pub const fn backend(&self) -> BackendKind {
        match self {
            Self::Starting { backend }
            | Self::Active { backend, .. }
            | Self::Restarting { backend }
            | Self::Failed { backend, .. } => *backend,
            Self::PermissionDenied { .. } | Self::DevicesUnavailable { .. } => {
                BackendKind::WaylandHelper
            }
            Self::ShuttingDown => BackendKind::WaylandHelper,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxSession {
    Wayland,
    X11,
    Unknown,
}

pub fn detect_linux_session(
    xdg_session_type: Option<&str>,
    wayland_display: Option<&str>,
    display: Option<&str>,
) -> LinuxSession {
    match xdg_session_type
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("wayland") => LinuxSession::Wayland,
        Some("x11") => LinuxSession::X11,
        _ if wayland_display.is_some_and(|value| !value.is_empty()) => LinuxSession::Wayland,
        _ if display.is_some_and(|value| !value.is_empty()) => LinuxSession::X11,
        _ => LinuxSession::Unknown,
    }
}

pub enum ShortcutManager {
    Native(NativeShortcutBackend),
    #[cfg(target_os = "linux")]
    Wayland(Box<wayland::WaylandSupervisor>),
}

impl ShortcutManager {
    pub fn native() -> Self {
        Self::Native(NativeShortcutBackend::new())
    }

    #[cfg(target_os = "linux")]
    pub fn wayland(app: tauri::AppHandle) -> Result<Self, ShortcutError> {
        wayland::WaylandSupervisor::spawn(app)
            .map(Box::new)
            .map(Self::Wayland)
    }

    #[cfg(not(target_os = "linux"))]
    pub fn wayland(_app: tauri::AppHandle) -> Result<Self, ShortcutError> {
        Err(ShortcutError::Backend(
            "Wayland helper is supported only on Linux".to_owned(),
        ))
    }

    pub fn status(&self) -> ShortcutBackendStatus {
        match self {
            Self::Native(backend) => backend.active_chord().map_or(
                ShortcutBackendStatus::Starting {
                    backend: BackendKind::Native,
                },
                |chord| ShortcutBackendStatus::Active {
                    backend: BackendKind::Native,
                    shortcut: chord.to_string(),
                    device_count: None,
                },
            ),
            #[cfg(target_os = "linux")]
            Self::Wayland(backend) => backend.status(),
        }
    }

    pub fn replace(
        &mut self,
        app: &tauri::AppHandle,
        chord: ShortcutChord,
    ) -> Result<(), ShortcutError> {
        match self {
            Self::Native(backend) => backend.register(app, chord),
            #[cfg(target_os = "linux")]
            Self::Wayland(backend) => backend.replace(&chord),
        }
    }

    pub fn retry(&mut self, _app: &tauri::AppHandle) -> Result<(), ShortcutError> {
        match self {
            Self::Native(_) => Ok(()),
            #[cfg(target_os = "linux")]
            Self::Wayland(backend) => backend.retry(),
        }
    }

    pub fn invalidate(&self) {
        #[cfg(target_os = "linux")]
        if let Self::Wayland(backend) = self {
            backend.invalidate();
        }
    }

    pub fn shutdown(&mut self, app: &tauri::AppHandle) -> Result<(), ShortcutError> {
        match self {
            Self::Native(backend) => backend.shutdown(app),
            #[cfg(target_os = "linux")]
            Self::Wayland(backend) => backend.shutdown(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_detection_prefers_xdg_and_uses_display_fallbacks() {
        assert_eq!(
            detect_linux_session(Some("wayland"), None, Some(":0")),
            LinuxSession::Wayland
        );
        assert_eq!(
            detect_linux_session(Some("x11"), Some("wayland-0"), None),
            LinuxSession::X11
        );
        assert_eq!(
            detect_linux_session(None, Some("wayland-0"), Some(":0")),
            LinuxSession::Wayland
        );
        assert_eq!(
            detect_linux_session(None, None, Some(":0")),
            LinuxSession::X11
        );
        assert_eq!(
            detect_linux_session(None, None, None),
            LinuxSession::Unknown
        );
    }
}
