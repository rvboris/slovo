//! XDG Desktop Portal `GlobalShortcuts` client for Wayland session support.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use tauri::AppHandle;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};
use zbus::{proxy, Connection, Proxy};

static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(1);

type PortalOptions<'a> = HashMap<String, zbus::zvariant::Value<'a>>;
type PortalShortcuts<'a> = [(String, PortalOptions<'a>); 1];

use crate::{handle_hotkey_action, HotkeyEvent};

/// Owns cancellation for the current Wayland portal worker.
pub struct PortalController {
    cancel: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl PortalController {
    pub fn new(app: AppHandle, hotkey: String, description: String) -> Self {
        let controller = Self {
            cancel: Mutex::new(None),
        };
        controller.restart(app, hotkey, description);
        controller
    }

    /// Cancel the previous session and start a replacement without blocking the caller.
    pub fn restart(&self, app: AppHandle, hotkey: String, description: String) {
        if let Ok(mut current) = self.cancel.lock() {
            if let Some(cancel) = current.take() {
                eprintln!("[slovo] portal: shutting down previous session");
                let _ = cancel.send(());
            }
            *current = spawn_portal_worker(app, hotkey, description);
        } else {
            eprintln!("[slovo] portal error: controller lock poisoned");
        }
    }
}

fn spawn_portal_worker(
    app: AppHandle,
    hotkey: String,
    description: String,
) -> Option<tokio::sync::oneshot::Sender<()>> {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        eprintln!("[slovo] portal: not wayland, skipping");
        return None;
    }

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    match std::thread::Builder::new()
        .name("slovo-portal".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[slovo] portal error: tokio runtime: {e}");
                    return;
                }
            };
            if let Err(e) = runtime.block_on(portal_loop(&app, &hotkey, &description, cancel_rx)) {
                eprintln!("[slovo] portal error: {e}");
            }
        }) {
        Ok(_) => Some(cancel_tx),
        Err(e) => {
            eprintln!("[slovo] portal error: cannot spawn portal thread: {e}");
            None
        }
    }
}

async fn portal_loop(
    app: &AppHandle,
    hotkey: &str,
    description: &str,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    let preferred_trigger = to_portal_trigger(hotkey)
        .map_err(|e| format!("preferred trigger conversion failed: {e}"))?;
    let connection = Connection::session()
        .await
        .map_err(|e| format!("session bus connect: {e}"))?;

    let proxy = GlobalShortcutsProxyProxy::new(&connection)
        .await
        .map_err(|e| format!("proxy new: {e}"))?;

    let create_token = unique_token("create");
    let session_token = unique_token("session");
    let create_path = request_path(&connection, &create_token)?;
    let mut create_response = subscribe_response(&connection, &create_path)
        .await
        .map_err(|e| format!("create session: {e}"))?;
    let mut session_opts = HashMap::new();
    session_opts.insert(
        "handle_token".to_string(),
        zbus::zvariant::Value::Str(create_token.as_str().into()),
    );
    session_opts.insert(
        "session_handle_token".to_string(),
        zbus::zvariant::Value::Str(session_token.as_str().into()),
    );
    eprintln!("[slovo] portal: creating session");
    let returned_create_path = proxy
        .create_session(&session_opts)
        .await
        .map_err(|e| format!("create session method: {e}"))?;
    ensure_request_path("create session", &create_path, &returned_create_path)?;
    let create_results = wait_create_response(&mut create_response)
        .await
        .map_err(|e| format!("create session response: {e}"))?;
    let session_handle = session_handle(&create_results)?;

    let (bind_token, shortcuts, bind_opts) =
        bind_arguments(description, preferred_trigger.as_str());
    let bind_path = request_path(&connection, &bind_token)?;
    let mut bind_response = subscribe_response(&connection, &bind_path)
        .await
        .map_err(|e| format!("bind shortcuts: {e}"))?;
    eprintln!("[slovo] portal: binding preferred trigger {preferred_trigger}");
    let returned_bind_path = proxy
        .bind_shortcuts(&session_handle, &shortcuts, "", &bind_opts)
        .await
        .map_err(|e| format!("bind shortcuts method: {e}"))?;
    ensure_request_path("bind shortcuts", &bind_path, &returned_bind_path)?;
    tokio::select! {
        response = wait_bind_response(&mut bind_response) => {
            response.map_err(|e| format!("bind shortcuts response: {e}"))?;
        }
        _ = &mut cancel_rx => {
            close_session(&connection, &session_handle).await;
            return Ok(());
        }
    }

    eprintln!("[slovo] portal bound, listening for shortcuts");

    // Listen for Activated/Deactivated until this controller is restarted.
    let mut activated = proxy
        .receive_activated()
        .await
        .map_err(|e| format!("subscribe activated: {e}"))?;
    let mut deactivated = proxy
        .receive_deactivated()
        .await
        .map_err(|e| format!("subscribe deactivated: {e}"))?;

    let app = Arc::new(app.clone());
    loop {
        tokio::select! {
            _ = &mut cancel_rx => break,
            Some(sig) = activated.next() => {
                if let Ok(args) = sig.args() {
                    if args.shortcut_id == "slovo_dictate" {
                        handle_hotkey_action(&app, HotkeyEvent::Pressed);
                    }
                }
            }
            Some(sig) = deactivated.next() => {
                if let Ok(args) = sig.args() {
                    if args.shortcut_id == "slovo_dictate" {
                        handle_hotkey_action(&app, HotkeyEvent::Released);
                    }
                }
            }
            else => break,
        }
    }
    close_session(&connection, &session_handle).await;
    Ok(())
}

fn bind_arguments<'a>(
    description: &'a str,
    preferred_trigger: &'a str,
) -> (String, PortalShortcuts<'a>, PortalOptions<'a>) {
    let bind_token = unique_token("bind");
    let mut shortcut = HashMap::new();
    shortcut.insert(
        "description".to_string(),
        zbus::zvariant::Value::Str(description.into()),
    );
    shortcut.insert(
        "preferred_trigger".to_string(),
        zbus::zvariant::Value::Str(preferred_trigger.into()),
    );
    let shortcuts = [("slovo_dictate".to_string(), shortcut)];
    let mut bind_opts = HashMap::new();
    bind_opts.insert(
        "handle_token".to_string(),
        zbus::zvariant::Value::Str(bind_token.as_str().to_owned().into()),
    );
    (bind_token, shortcuts, bind_opts)
}

fn unique_token(stage: &str) -> String {
    let sequence = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("slovo_{stage}_{}_{}", std::process::id(), sequence)
}

fn request_path(connection: &Connection, token: &str) -> Result<OwnedObjectPath, String> {
    let sender = connection
        .unique_name()
        .ok_or("D-Bus connection has no unique name")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    OwnedObjectPath::try_from(format!(
        "/org/freedesktop/portal/desktop/request/{sender}/{token}"
    ))
    .map_err(|e| format!("invalid predicted request path: {e}"))
}

async fn subscribe_response<'a>(
    connection: &'a Connection,
    request_path: &'a OwnedObjectPath,
) -> Result<zbus::proxy::SignalStream<'a>, String> {
    let request_proxy = Proxy::new(
        connection,
        "org.freedesktop.portal.Desktop",
        request_path.clone(),
        "org.freedesktop.portal.Request",
    )
    .await
    .map_err(|e| format!("request proxy: {e}"))?;
    request_proxy
        .receive_signal("Response")
        .await
        .map_err(|e| format!("subscribe Response: {e}"))
}

fn ensure_request_path(
    stage: &str,
    predicted: &OwnedObjectPath,
    returned: &OwnedObjectPath,
) -> Result<(), String> {
    if predicted == returned {
        Ok(())
    } else {
        Err(format!(
            "{stage} returned unexpected request path {returned}; expected {predicted}"
        ))
    }
}

async fn wait_create_response(
    stream: &mut zbus::proxy::SignalStream<'_>,
) -> Result<HashMap<String, OwnedValue>, String> {
    let message = tokio::time::timeout(std::time::Duration::from_mins(1), stream.next())
        .await
        .map_err(|_| "portal response timed out".to_string())?
        .ok_or("portal response stream ended")?;
    parse_response(&message)
}

async fn wait_bind_response(
    stream: &mut zbus::proxy::SignalStream<'_>,
) -> Result<HashMap<String, OwnedValue>, String> {
    let message = stream.next().await.ok_or("portal response stream ended")?;
    parse_response(&message)
}

fn parse_response(message: &zbus::Message) -> Result<HashMap<String, OwnedValue>, String> {
    let (code, results): (u32, HashMap<String, OwnedValue>) = message
        .body()
        .deserialize()
        .map_err(|e| format!("portal response parse: {e}"))?;
    if code != 0 {
        return Err(format!("portal denied request: code {code}"));
    }
    Ok(results)
}

async fn close_session(connection: &Connection, session_handle: &OwnedObjectPath) {
    let result = async {
        let session = Proxy::new(
            connection,
            "org.freedesktop.portal.Desktop",
            session_handle.clone(),
            "org.freedesktop.portal.Session",
        )
        .await?;
        session.call::<_, _, ()>("Close", &()).await
    }
    .await;
    if let Err(error) = result {
        eprintln!("[slovo] portal error: close session: {error}");
    }
}

fn session_handle(results: &HashMap<String, OwnedValue>) -> Result<OwnedObjectPath, String> {
    let handle = results
        .get("session_handle")
        .ok_or("create session response has no session_handle")?;
    let handle = handle
        .downcast_ref::<String>()
        .map_err(|e| format!("invalid session_handle value: {e}"))?;
    if handle.is_empty() {
        return Err("create session returned an empty session_handle".into());
    }
    OwnedObjectPath::try_from(handle.as_str()).map_err(|e| format!("invalid session_handle: {e}"))
}

pub(crate) fn to_portal_trigger(hotkey: &str) -> Result<String, String> {
    let parts = hotkey
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let (key, modifiers) = parts
        .split_last()
        .ok_or_else(|| "hotkey is empty".to_owned())?;
    let mut trigger = Vec::with_capacity(parts.len());
    for modifier in modifiers {
        let portal_modifier = match modifier.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => "CTRL",
            "alt" => "ALT",
            "shift" => "SHIFT",
            "super" | "meta" | "logo" => "LOGO",
            _ => return Err(format!("unsupported hotkey modifier: {modifier}")),
        };
        trigger.push(portal_modifier.to_owned());
    }
    trigger.push(portal_key(key)?);
    Ok(trigger.join("+"))
}

fn portal_key(key: &str) -> Result<String, String> {
    if let Some(letter) = key.strip_prefix("Key") {
        if letter.len() == 1 && letter.as_bytes()[0].is_ascii_uppercase() {
            return Ok(letter.to_ascii_lowercase());
        }
    }
    if let Some(digit) = key.strip_prefix("Digit") {
        if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() {
            return Ok(digit.to_owned());
        }
    }
    if let Some(function) = key.strip_prefix('F') {
        if function
            .parse::<u8>()
            .is_ok_and(|number| (1..=24).contains(&number))
        {
            return Ok(format!("F{function}"));
        }
    }
    let keysym = match key {
        "Backquote" => "grave",
        "Backslash" => "backslash",
        "BracketLeft" => "bracketleft",
        "BracketRight" => "bracketright",
        "Comma" => "comma",
        "Equal" => "equal",
        "Minus" => "minus",
        "Period" => "period",
        "Quote" => "apostrophe",
        "Semicolon" => "semicolon",
        "Slash" => "slash",
        "Backspace" => "BackSpace",
        "Delete" => "Delete",
        "End" => "End",
        "Enter" => "Return",
        "Home" => "Home",
        "Insert" => "Insert",
        "PageDown" => "Next",
        "PageUp" => "Prior",
        "Space" => "space",
        "Tab" => "Tab",
        "ArrowDown" => "Down",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "ArrowUp" => "Up",
        _ => return Err(format!("unsupported hotkey key: {key}")),
    };
    Ok(keysym.to_owned())
}

#[proxy(
    interface = "org.freedesktop.portal.GlobalShortcuts",
    default_service = "org.freedesktop.portal.Desktop",
    default_path = "/org/freedesktop/portal/desktop"
)]
trait GlobalShortcutsProxy {
    fn create_session(
        &self,
        options: &HashMap<String, zbus::zvariant::Value<'_>>,
    ) -> zbus::Result<OwnedObjectPath>;

    fn bind_shortcuts(
        &self,
        session_handle: &OwnedObjectPath,
        shortcuts: &[(String, HashMap<String, zbus::zvariant::Value<'_>>)],
        parent_window: &str,
        options: &HashMap<String, zbus::zvariant::Value<'_>>,
    ) -> zbus::Result<OwnedObjectPath>;

    #[zbus(signal)]
    fn activated(
        &self,
        session_handle: OwnedObjectPath,
        shortcut_id: String,
        timestamp: u64,
        options: HashMap<String, OwnedValue>,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    fn deactivated(
        &self,
        session_handle: OwnedObjectPath,
        shortcut_id: String,
        timestamp: u64,
        options: HashMap<String, OwnedValue>,
    ) -> zbus::Result<()>;
}

#[cfg(test)]
mod tests {
    use super::to_portal_trigger;

    #[test]
    fn converts_documented_examples() {
        assert_eq!(to_portal_trigger("Ctrl+Digit2").unwrap(), "CTRL+2");
        assert_eq!(
            to_portal_trigger("Control+Shift+Space").unwrap(),
            "CTRL+SHIFT+space"
        );
        assert_eq!(to_portal_trigger("Ctrl+Backquote").unwrap(), "CTRL+grave");
        assert_eq!(to_portal_trigger("Ctrl+KeyQ").unwrap(), "CTRL+q");
    }

    #[test]
    fn converts_modifiers_and_punctuation() {
        assert_eq!(
            to_portal_trigger("Alt+Shift+Super+Comma").unwrap(),
            "ALT+SHIFT+LOGO+comma"
        );
        assert_eq!(
            to_portal_trigger("Meta+Control+Quote").unwrap(),
            "LOGO+CTRL+apostrophe"
        );
        assert_eq!(to_portal_trigger("Logo+Slash").unwrap(), "LOGO+slash");
    }

    #[test]
    fn converts_navigation_and_function_keys() {
        assert_eq!(to_portal_trigger("Ctrl+PageDown").unwrap(), "CTRL+Next");
        assert_eq!(to_portal_trigger("Alt+ArrowLeft").unwrap(), "ALT+Left");
        assert_eq!(to_portal_trigger("Shift+F24").unwrap(), "SHIFT+F24");
    }

    #[test]
    fn rejects_unsupported_or_malformed_parts() {
        assert!(to_portal_trigger("").unwrap_err().contains("empty"));
        assert!(to_portal_trigger("Hyper+KeyQ")
            .unwrap_err()
            .contains("modifier"));
        assert!(to_portal_trigger("Ctrl+KeyÄ")
            .unwrap_err()
            .contains("unsupported hotkey key"));
        assert!(to_portal_trigger("Ctrl+F25")
            .unwrap_err()
            .contains("unsupported hotkey key"));
    }
}
