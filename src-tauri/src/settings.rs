use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};
use url::Url;

pub const DEFAULT_HOTKEY: &str = "Control+Shift+Space";
pub const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:8072";
const TRANSCRIPTION_PATH: &str = "/v1/audio/transcriptions";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TriggerType {
    Toggle,
    Hold,
    AutoVad,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Settings {
    pub hotkey: String,
    #[serde(alias = "server_url")]
    pub server_url: String,
    #[serde(alias = "trigger_type")]
    pub trigger_type: TriggerType,
    #[serde(default, alias = "input_device")]
    pub input_device: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: DEFAULT_HOTKEY.into(),
            server_url: DEFAULT_SERVER_URL.into(),
            trigger_type: TriggerType::Toggle,
            input_device: None,
        }
    }
}

pub fn normalize_server_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let url = Url::parse(value).map_err(|error| format!("invalid server URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("server URL must be an absolute HTTP(S) URL".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("server URL must not contain a query or fragment".into());
    }
    Ok(value.to_owned())
}

pub fn transcription_url(value: &str) -> Result<String, String> {
    let normalized = normalize_server_url(value)?;
    if normalized.ends_with(TRANSCRIPTION_PATH) {
        Ok(normalized)
    } else {
        Ok(format!("{normalized}{TRANSCRIPTION_PATH}"))
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("settings.json"))
        .map_err(|error| error.to_string())
}

fn load_from_path(path: &std::path::Path) -> Result<Settings, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let mut settings: Settings =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    // Persisted device names can drift (quotes, surrounding whitespace, or an
    // empty string saved by an older build). Normalize at the load boundary so
    // every consumer sees a trimmed, non-empty name or `None`.
    settings.input_device = settings
        .input_device
        .take()
        .map(|device| device.trim().to_owned())
        .filter(|device| !device.is_empty());
    Ok(settings)
}

fn save_to_path(path: &std::path::Path, settings: &Settings) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid settings path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

pub fn load(app: &AppHandle) -> Settings {
    path(app)
        .and_then(|path| load_from_path(&path))
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    save_to_path(&path(app)?, settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_appends_endpoint() {
        assert_eq!(
            transcription_url(" http://localhost:8072/ ").unwrap(),
            "http://localhost:8072/v1/audio/transcriptions"
        );
        assert_eq!(
            transcription_url("https://host/api/v1/audio/transcriptions").unwrap(),
            "https://host/api/v1/audio/transcriptions"
        );
    }

    #[test]
    fn rejects_non_http_or_relative_urls() {
        assert!(normalize_server_url("localhost:8072").is_err());
        assert!(normalize_server_url("file:///tmp/server").is_err());
    }

    #[test]
    fn settings_use_frontend_camel_case_contract() {
        let settings = Settings {
            hotkey: "Ctrl+Backquote".into(),
            server_url: "http://127.0.0.1:8072".into(),
            trigger_type: TriggerType::Hold,
            input_device: None,
        };
        let json = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["hotkey"], "Ctrl+Backquote");
        assert_eq!(json["serverUrl"], "http://127.0.0.1:8072");
        assert_eq!(json["triggerType"], "hold");
        assert!(json.get("server_url").is_none());
        assert_eq!(json.get("inputDevice").and_then(|v| v.as_str()), None);
    }

    #[test]
    fn settings_accept_frontend_update_payload() {
        let settings: Settings = serde_json::from_str(
            r#"{"hotkey":"Ctrl+Backquote","serverUrl":"http://localhost:8072","triggerType":"auto-vad","inputDevice":"Built-in Mic"}"#,
        )
        .unwrap();
        assert_eq!(settings.hotkey, "Ctrl+Backquote");
        assert_eq!(settings.server_url, "http://localhost:8072");
        assert_eq!(settings.trigger_type, TriggerType::AutoVad);
        assert_eq!(settings.input_device.as_deref(), Some("Built-in Mic"));
    }

    #[test]
    fn settings_round_trip_on_disk() {
        let directory = std::env::temp_dir().join(format!(
            "slovo-settings-test-{}-{}",
            std::process::id(),
            // Windows forbids ':' in file names; thread names contain "::".
            std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .replace(':', "-")
        ));
        let path = directory.join("settings.json");
        let settings = Settings {
            hotkey: "Ctrl+Backquote".into(),
            server_url: "https://example.test:8072".into(),
            trigger_type: TriggerType::AutoVad,
            input_device: Some("USB Mic".into()),
        };
        save_to_path(&path, &settings).unwrap();
        assert_eq!(load_from_path(&path).unwrap(), settings);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn settings_default_without_input_device() {
        assert!(Settings::default().input_device.is_none());
    }
}
