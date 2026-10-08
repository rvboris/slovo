use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

fn clipboard_handle() -> &'static Mutex<Option<Clipboard>> {
    static HANDLE: OnceLock<Mutex<Option<Clipboard>>> = OnceLock::new();
    HANDLE.get_or_init(|| Mutex::new(None))
}

fn session() -> Session {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        Session::Wayland
    } else if cfg!(target_os = "linux") && std::env::var_os("DISPLAY").is_none() {
        Session::Headless
    } else {
        Session::Native
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Session {
    Headless,
    Wayland,
    Native,
}

fn set_clipboard(text: &str) -> Result<(), String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return set_wayland_clipboard(text, |primary, bytes| {
            let mut cmd = Command::new("wl-copy");
            if primary {
                cmd.arg("--primary");
            }
            let mut child = cmd
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| format!("cannot spawn wl-copy: {error}"))?;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(bytes);
            }
            let _ = child.wait();
            Ok(())
        });
    }

    let handle = clipboard_handle();
    let mut guard = handle
        .lock()
        .map_err(|_| "clipboard mutex poisoned".to_owned())?;
    if guard.is_none() {
        *guard = Some(Clipboard::new().map_err(|error| format!("cannot open clipboard: {error}"))?);
    }
    let clipboard = guard.as_mut().expect("just initialised");
    if let Err(error) = clipboard.set_text(text) {
        *guard = None;
        return Err(format!("cannot write clipboard: {error}"));
    }
    drop(guard);
    Ok(())
}

fn set_wayland_clipboard<F>(text: &str, mut write: F) -> Result<(), String>
where
    F: FnMut(bool, &[u8]) -> Result<(), String>,
{
    for primary in [false, true] {
        write(primary, text.as_bytes())?;
    }
    Ok(())
}

fn copy_and_insert_with<C, W, I>(
    text: &str,
    selected: Session,
    mut clipboard: C,
    mut wait: W,
    mut inject: I,
) -> Result<bool, String>
where
    C: FnMut(&str) -> Result<(), String>,
    W: FnMut(),
    I: FnMut() -> Result<bool, String>,
{
    if selected == Session::Headless {
        return Ok(false);
    }
    clipboard(text)?;
    wait();
    inject()
}

pub fn copy_and_insert(text: &str) -> Result<bool, String> {
    match session() {
        Session::Headless => Ok(false),
        Session::Wayland => copy_and_insert_with(
            text,
            Session::Wayland,
            set_clipboard,
            || std::thread::sleep(std::time::Duration::from_millis(300)),
            || {
                let status = Command::new("ydotool")
                    .args(["key", "42:1", "110:1", "110:0", "42:0"])
                    .stdin(Stdio::null())
                    .status()
                    .map_err(|error| {
                        format!("clipboard populated; paste injection unavailable: {error}")
                    })?;
                Ok(status.success())
            },
        ),
        Session::Native => copy_and_insert_with(
            text,
            Session::Native,
            set_clipboard,
            || {},
            || {
                let mut enigo = Enigo::new(&Settings::default()).map_err(|error| {
                    format!("clipboard populated; input injection unavailable: {error}")
                })?;
                enigo
                    .key(Key::Control, Direction::Press)
                    .and_then(|()| enigo.key(Key::Unicode('v'), Direction::Click))
                    .and_then(|()| enigo.key(Key::Control, Direction::Release))
                    .map_err(|error| {
                        format!("clipboard populated; paste injection failed: {error}")
                    })?;
                Ok(true)
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headless_does_not_touch_clipboard_or_injection() {
        let calls = std::cell::Cell::new(0);
        let result = copy_and_insert_with(
            "text",
            Session::Headless,
            |_| {
                calls.set(calls.get() + 1);
                Ok(())
            },
            || calls.set(calls.get() + 1),
            || {
                calls.set(calls.get() + 1);
                Ok(true)
            },
        );
        assert!(!result.unwrap());
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn wayland_writes_utf8_to_both_selections() {
        let writes = std::cell::RefCell::new(Vec::new());
        set_wayland_clipboard("текст", |primary, bytes| {
            writes.borrow_mut().push((primary, bytes.to_vec()));
            Ok(())
        })
        .unwrap();
        assert_eq!(
            writes.borrow().as_slice(),
            &[
                (false, "текст".as_bytes().to_vec()),
                (true, "текст".as_bytes().to_vec())
            ]
        );
    }

    #[test]
    fn wayland_spawn_failure_stops_after_first_operation() {
        let calls = std::cell::Cell::new(0);
        let error = set_wayland_clipboard("text", |_, _| {
            calls.set(calls.get() + 1);
            Err("cannot spawn wl-copy".into())
        })
        .unwrap_err();
        assert!(error.contains("spawn"));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn ydotool_operation_is_injected_after_clipboard() {
        let calls = std::cell::RefCell::new(Vec::new());
        let result = copy_and_insert_with(
            "text",
            Session::Wayland,
            |text| {
                calls.borrow_mut().push(format!("clipboard:{text}"));
                Ok(())
            },
            || calls.borrow_mut().push("wait".into()),
            || {
                calls
                    .borrow_mut()
                    .push("ydotool key 42:1 110:1 110:0 42:0".into());
                Ok(true)
            },
        )
        .unwrap();
        assert!(result);
        assert_eq!(
            calls.borrow().as_slice(),
            &[
                "clipboard:text",
                "wait",
                "ydotool key 42:1 110:1 110:0 42:0"
            ]
        );
    }

    #[test]
    fn injection_exit_status_and_error_are_preserved() {
        assert!(
            !copy_and_insert_with("x", Session::Wayland, |_| Ok(()), || {}, || Ok(false)).unwrap()
        );
        let error = copy_and_insert_with(
            "x",
            Session::Wayland,
            |_| Ok(()),
            || {},
            || Err("clipboard populated; paste injection unavailable: failed".into()),
        )
        .unwrap_err();
        assert!(error.contains("clipboard populated"));
        assert!(error.contains("paste injection unavailable"));
    }
}
