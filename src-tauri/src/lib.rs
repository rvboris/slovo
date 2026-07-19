//! Slovo — Linux-first push-to-talk transcription.
//!
//! The crate is organised into focused modules so each file has a single
//! responsibility:
//!
//! - [`state`] — aggregate [`AppState`] and the consolidated lock guards.
//! - [`commands`] — `#[tauri::command]` handlers exposed to the frontend.
//! - [`hotkey`] — hotkey parsing, normalization, and the recording lifecycle.
//! - [`permissions`] — udev rule preparation and the shell commands that
//!   install or revoke it.
//! - [`app`] — tray menu, plugin wiring, and the Tauri run loop.
//!
//! The remaining siblings (`audio`, `output`, `portal`, `settings`,
//! `shortcut`, `transcription`, `trigger`) are subsystem implementations.

mod app;
mod audio;
mod commands;
mod hotkey;
mod output;
mod permissions;
mod portal;
mod settings;
mod shortcut;
mod state;
mod transcription;
mod trigger;

pub use app::run;
pub use hotkey::{handle_hotkey_action, HotkeyEvent};
pub use state::AppState;

#[cfg(test)]
mod tests {
    use super::permissions::{
        installed_rule_matches, log_permission_setup_dir, log_permission_setup_message,
        permission_setup_dir_from_env_only, permission_setup_for_path, prepare_shortcut_rule,
        shell_quote, SHORTCUT_RULE, SHORTCUT_RULE_NAME,
    };
    use crate::hotkey::{canonicalize_hotkey, parse_hotkey};
    use std::path::{Path, PathBuf};
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
        use crate::permissions::permission_setup_in_directory;
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

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }
}
