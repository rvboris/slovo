use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

/// Long-lived clipboard handle. On X11 the clipboard contents are served by a
/// worker thread inside `arboard::Clipboard`; dropping the handle releases
/// ownership of the `CLIPBOARD` selection. Keeping one handle alive for the
/// process lifetime means the contents stay available until overwritten.
fn clipboard_handle() -> &'static Mutex<Option<Clipboard>> {
    static HANDLE: OnceLock<Mutex<Option<Clipboard>>> = OnceLock::new();
    HANDLE.get_or_init(|| Mutex::new(None))
}

/// Set clipboard text. On Wayland, uses `wl-copy` (forks into background and
/// stays alive as clipboard owner). On X11, keeps a long-lived `arboard`
/// handle. `wl-copy` is essential on GNOME/Mutter which doesn't support
/// `wl_data_control_manager_v1` that arboard relies on.
fn set_clipboard(text: &str) -> Result<(), String> {
    // Wayland: write to BOTH clipboard and primary selection.
    // Shift+Insert pastes from primary on some apps, clipboard on others.
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        for primary in [false, true] {
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
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
        }
        return Ok(());
    }

    // X11: long-lived arboard handle.
    let clipboard_handle = clipboard_handle();
    let mut guard = clipboard_handle
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

pub fn copy_and_insert(text: &str) -> Result<bool, String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        set_clipboard(text)?;
        // GNOME/Mutter focus-restoration race: after the recording overlay is
        // hidden, Mutter takes time to return keyboard focus to the target
        // window. If ydotool fires too soon, the keystroke goes into a void.
        std::thread::sleep(std::time::Duration::from_millis(300));
        // Shift+Insert: universal paste — works in terminals AND GUI apps.
        // Ctrl+V doesn't work in terminals (they use Ctrl+Shift+V).
        // evdev: 42=LShift, 110=Insert.
        let status = Command::new("ydotool")
            .args(["key", "42:1", "110:1", "110:0", "42:0"])
            .stdin(Stdio::null())
            .status()
            .map_err(|error| {
                format!("clipboard populated; paste injection unavailable: {error}")
            })?;
        return Ok(status.success());
    }

    // `DISPLAY` exists only on X11 Linux; on Windows and macOS the native
    // enigo backend needs no display server check.
    #[cfg(target_os = "linux")]
    if std::env::var_os("DISPLAY").is_none() {
        return Ok(false);
    }
    set_clipboard(text)?;

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|error| format!("clipboard populated; input injection unavailable: {error}"))?;
    enigo
        .key(Key::Control, Direction::Press)
        .and_then(|()| enigo.key(Key::Unicode('v'), Direction::Click))
        .and_then(|()| enigo.key(Key::Control, Direction::Release))
        .map_err(|error| format!("clipboard populated; paste injection failed: {error}"))?;
    Ok(true)
}
