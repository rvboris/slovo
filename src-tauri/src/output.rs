use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};

pub fn copy_and_insert(text: &str) -> Result<bool, String> {
    Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|error| format!("cannot write clipboard: {error}"))?;

    if std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var_os("DISPLAY").is_none() {
        return Ok(false);
    }

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|error| format!("clipboard populated; input injection unavailable: {error}"))?;
    enigo
        .key(Key::Control, Direction::Press)
        .and_then(|()| enigo.key(Key::Unicode('v'), Direction::Click))
        .and_then(|()| enigo.key(Key::Control, Direction::Release))
        .map_err(|error| format!("clipboard populated; paste injection failed: {error}"))?;
    Ok(true)
}
