use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf};
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

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Settings {
    pub hotkey: String,
    #[serde(alias = "server_url")]
    pub server_url: String,
    #[serde(alias = "trigger_type")]
    pub trigger_type: TriggerType,
    #[serde(default, alias = "input_device")]
    pub input_device: Option<String>,
    pub llm_server_url: Option<String>,
    pub llm_model: Option<String>,
    pub llm_api_key: Option<String>,
    pub llm_prompt: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[allow(clippy::struct_field_names)] // Fields match the existing frontend settings contract.
pub struct CorrectionSettings {
    pub llm_server_url: Option<String>,
    pub llm_model: Option<String>,
    pub llm_api_key: Option<String>,
    pub llm_prompt: Option<String>,
}

impl CorrectionSettings {
    pub fn apply(self, settings: &mut Settings) -> Result<(), String> {
        let clean =
            |value: Option<String>| value.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        let url = clean(self.llm_server_url);
        let model = clean(self.llm_model);
        let prompt = clean(self.llm_prompt);
        if let Some(value) = &url {
            let parsed = Url::parse(value).map_err(|_| "Некорректный адрес API")?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err("Укажите HTTP(S)-адрес без логина и пароля".into());
            }
            if model.is_none() || prompt.is_none() {
                return Err("Для корректировки укажите модель и инструкцию".into());
            }
        }
        settings.llm_server_url = url;
        settings.llm_model = model;
        settings.llm_api_key = clean(self.llm_api_key);
        settings.llm_prompt = prompt;
        Ok(())
    }
}

pub fn preserve_correction(next: &mut Settings, current: &Settings) {
    next.llm_server_url.clone_from(&current.llm_server_url);
    next.llm_model.clone_from(&current.llm_model);
    next.llm_api_key.clone_from(&current.llm_api_key);
    next.llm_prompt.clone_from(&current.llm_prompt);
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings").finish_non_exhaustive()
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: DEFAULT_HOTKEY.into(),
            server_url: DEFAULT_SERVER_URL.into(),
            trigger_type: TriggerType::Toggle,
            input_device: None,
            llm_server_url: None,
            llm_model: None,
            llm_api_key: None,
            llm_prompt: None,
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
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    // Remove a leftover temporary file without following a possible symlink.
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
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
    fn separate_windows_preserve_each_others_fields() {
        let mut current = Settings::default();
        let mut stale_main = current.clone();
        let correction = || CorrectionSettings {
            llm_server_url: Some("https://example.invalid/v1".into()),
            llm_model: Some("model".into()),
            llm_api_key: Some("secret".into()),
            llm_prompt: Some("Исправь текст".into()),
        };
        correction().apply(&mut current).unwrap();
        stale_main.server_url = "http://localhost:9000".into();
        preserve_correction(&mut stale_main, &current);
        assert_eq!(stale_main.llm_api_key, current.llm_api_key);
        assert_eq!(stale_main.llm_prompt, current.llm_prompt);
        correction().apply(&mut stale_main).unwrap();
        assert_eq!(stale_main.server_url, "http://localhost:9000");
        let mut invalid = correction();
        invalid.llm_model = None;
        assert!(invalid.apply(&mut stale_main).is_err());
        let mut disabled = correction();
        disabled.llm_server_url = Some(" ".into());
        disabled.llm_model = None;
        disabled.apply(&mut stale_main).unwrap();
        assert!(stale_main.llm_server_url.is_none());
        assert_eq!(stale_main.server_url, "http://localhost:9000");
    }

    #[test]
    fn rejected_correction_update_is_transactional() {
        let mut settings = Settings {
            llm_api_key: Some("existing-secret".into()),
            ..Settings::default()
        };
        let before = settings.clone();
        for url in [
            "file:///tmp/api",
            "https://user:password@example.test",
            "not a url",
        ] {
            let update = CorrectionSettings {
                llm_server_url: Some(url.into()),
                llm_model: Some("model".into()),
                llm_api_key: Some("replacement-secret".into()),
                llm_prompt: Some("prompt".into()),
            };
            assert!(update.apply(&mut settings).is_err());
            assert_eq!(settings, before);
        }
    }

    #[test]
    fn debug_never_contains_settings_values() {
        let settings = Settings {
            server_url: "https://private-host.test".into(),
            llm_api_key: Some("private-token".into()),
            llm_prompt: Some("private-prompt".into()),
            input_device: Some("private-device".into()),
            ..Settings::default()
        };
        assert_eq!(format!("{settings:?}"), "Settings { .. }");
    }

    #[test]
    fn settings_reject_unknown_fields_and_url_suffix_metadata() {
        assert!(serde_json::from_str::<Settings>(r#"{"llmApiKeey":"secret"}"#).is_err());
        assert!(
            serde_json::from_str::<CorrectionSettings>(r#"{"serverUrl":"https://host"}"#).is_err()
        );
        for url in ["https://host?token=secret", "https://host/#fragment"] {
            assert!(normalize_server_url(url).is_err());
            assert!(transcription_url(url).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn saving_replaces_temp_symlink_without_touching_target() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory =
            std::env::temp_dir().join(format!("slovo-symlink-test-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");
        let victim = directory.join("victim");
        fs::write(&victim, b"do not overwrite").unwrap();
        symlink(&victim, path.with_extension("json.tmp")).unwrap();
        let settings = Settings {
            llm_api_key: Some("secret".into()),
            ..Settings::default()
        };
        save_to_path(&path, &settings).unwrap();
        assert_eq!(fs::read(&victim).unwrap(), b"do not overwrite");
        assert_eq!(load_from_path(&path).unwrap(), settings);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!path.with_extension("json.tmp").exists());
        fs::remove_dir_all(directory).unwrap();
    }

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
            ..Settings::default()
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
        assert!(settings.llm_server_url.is_none());
        let json = serde_json::to_value(&settings).unwrap();
        for key in ["llmServerUrl", "llmModel", "llmApiKey", "llmPrompt"] {
            assert!(json[key].is_null());
        }
        assert_eq!(serde_json::from_value::<Settings>(json).unwrap(), settings);
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
            llm_server_url: Some("https://example.test/v1".into()),
            llm_model: Some("test-model".into()),
            llm_api_key: Some("private-key".into()),
            llm_prompt: Some("fix text".into()),
        };
        save_to_path(&path, &settings).unwrap();
        assert_eq!(load_from_path(&path).unwrap(), settings);
        assert!(!format!("{settings:?}").contains("private-key"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            save_to_path(&path, &settings).unwrap();
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn settings_default_without_input_device() {
        assert!(Settings::default().input_device.is_none());
    }
}
