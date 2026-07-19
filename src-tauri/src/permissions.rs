//! udev rule permission setup for the Wayland evdev hotkey helper.
//!
//! On Linux the helper needs read access to `/dev/input/event*` devices. The
//! frontend asks the user to install a udev rule (via `sudo`) that grants the
//! active graphical user that access through `uaccess`. This module prepares
//! that rule atomically and produces the exact shell commands the user should
//! run, plus diagnostics and revocation commands.

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(crate) const SHORTCUT_RULE_NAME: &str = "72-slovo-input-helper.rules";
pub(crate) const SHORTCUT_RULE_DESTINATION: &str =
    "/usr/lib/udev/rules.d/72-slovo-input-helper.rules";
pub(crate) const SHORTCUT_RULE: &str = include_str!("../resources/72-slovo-input-helper.rules");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShortcutPermissionSetup {
    supported: bool,
    pub(crate) disclosure: String,
    pub(crate) install_commands: Vec<String>,
    pub(crate) revoke_commands: Vec<String>,
    destination: String,
    installed: bool,
    pub(crate) prepared_rule_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    setup_error: Option<String>,
    note: String,
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn installed_rule_matches(path: &Path) -> bool {
    std::fs::read(path).is_ok_and(|content| content == SHORTCUT_RULE.as_bytes())
}

#[cfg(unix)]
pub(crate) fn prepare_shortcut_rule(directory: &Path) -> Result<PathBuf, String> {
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
    file.write_all(SHORTCUT_RULE.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("cannot write permission rule: {error}"))?;
    std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o644))
        .map_err(|error| format!("cannot set permission rule mode: {error}"))?;
    std::fs::rename(&temporary, &destination)
        .map_err(|error| format!("cannot publish permission rule: {error}"))?;
    Ok(destination)
}

#[cfg(not(unix))]
pub(crate) fn prepare_shortcut_rule(_directory: &Path) -> Result<PathBuf, String> {
    Err("permission setup is supported only on Linux".into())
}

pub(crate) fn permission_setup_for_path(
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
pub(crate) fn permission_setup_in_directory(
    directory: &Path,
) -> Result<ShortcutPermissionSetup, String> {
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

/// Resolves a stable, user-writable directory for the prepared udev rule.
///
/// Tauri's `app_config_dir()` is the canonical home on most systems
/// (`$XDG_CONFIG_HOME/com.slovo.app` or `~/.config/com.slovo.app`), but in some
/// dev/embedded configurations it returns `Err`. As a no-new-dependency fallback
/// we honor `XDG_CONFIG_HOME` / `HOME` manually and join the Tauri identifier,
/// matching the same `com.slovo.app` path the app uses elsewhere.
pub(crate) fn resolve_permission_setup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(directory) = app.path().app_config_dir() {
        return Ok(directory);
    }
    permission_setup_dir_from_env_only()
}

/// No-new-dependency fallback honored when Tauri cannot resolve the config dir.
/// Resolves `$XDG_CONFIG_HOME/com.slovo.app` or `$HOME/.config/com.slovo.app`,
/// matching `dirs::config_dir()` semantics joined with the Tauri identifier.
pub(crate) fn permission_setup_dir_from_env_only() -> Result<PathBuf, String> {
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
pub(crate) fn log_permission_setup_message(message: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "[slovo] {message}");
    let _ = std::io::stderr().flush();
}

pub(crate) fn log_permission_setup_dir(directory: &Result<PathBuf, String>) {
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
