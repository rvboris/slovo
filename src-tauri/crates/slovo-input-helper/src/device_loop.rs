use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use evdev::{Device, EventSummary, KeyCode};
use polling::{Event, Events, PollMode, Poller};

use slovo_shortcut_core::matcher::{DeviceId, InputCode, InputValue, MatchEvent, Matcher};

use crate::evdev_debug_enabled;

const RESCAN_INTERVAL: Duration = Duration::from_secs(5);
const DEVICE_KEY_BASE: usize = 2;
const UDEV_KEY: usize = 1;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScanSummary {
    pub keyboards: usize,
    pub readable: usize,
    pub permission_denied: usize,
}

struct OpenDevice {
    id: DeviceId,
    device: Device,
}

pub struct DeviceLoop {
    poller: Poller,
    events: Events,
    monitor: udev::MonitorSocket,
    devices: HashMap<PathBuf, OpenDevice>,
    next_id: DeviceId,
    last_scan: Instant,
    removed_ids: Vec<DeviceId>,
}

impl DeviceLoop {
    pub fn new() -> io::Result<Self> {
        let monitor = udev::MonitorBuilder::new()?
            .match_subsystem("input")?
            .listen()?;
        let poller = Poller::new()?;
        unsafe {
            poller.add_with_mode(&monitor, Event::readable(UDEV_KEY), PollMode::Oneshot)?;
        }
        Ok(Self {
            poller,
            events: Events::new(),
            monitor,
            devices: HashMap::new(),
            next_id: 1,
            last_scan: Instant::now()
                .checked_sub(RESCAN_INTERVAL)
                .unwrap_or_else(Instant::now),
            removed_ids: Vec::new(),
        })
    }

    pub fn device_count(&self) -> usize {
        self.devices.len()
    }

    pub fn rescan(&mut self, matcher: &mut Matcher) -> (ScanSummary, Vec<MatchEvent>) {
        self.last_scan = Instant::now();
        let mut emitted = Vec::new();
        let mut summary = ScanSummary::default();
        let mut present = HashSet::new();
        let entries = match fs::read_dir("/dev/input") {
            Ok(entries) => entries,
            Err(error) => {
                if error.kind() == io::ErrorKind::PermissionDenied {
                    summary.permission_denied += 1;
                }
                return (summary, emitted);
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_name().to_string_lossy().starts_with("event") {
                continue;
            }
            present.insert(path.clone());
            if self.devices.contains_key(&path) {
                summary.keyboards += 1;
                summary.readable += 1;
                continue;
            }
            match Device::open(&path) {
                Ok(device) if is_keyboard(&device) => {
                    summary.keyboards += 1;
                    if let Err(error) = device.set_nonblocking(true) {
                        classify_open_error(&error, &mut summary);
                        continue;
                    }
                    let id = self.next_id;
                    self.next_id += 1;
                    let key = DEVICE_KEY_BASE + id as usize;
                    let registered = unsafe {
                        self.poller
                            .add_with_mode(&device, Event::readable(key), PollMode::Oneshot)
                    };
                    if registered.is_ok() {
                        if evdev_debug_enabled() {
                            eprintln!(
                                "[slovo-input-helper] evdev accepted path={} id={} name={}",
                                path.display(),
                                id,
                                device.name().unwrap_or("unknown")
                            );
                        }
                        matcher.add_device(id);
                        self.devices.insert(path, OpenDevice { id, device });
                        summary.readable += 1;
                    }
                }
                Ok(_) => {}
                Err(error) => classify_open_error(&error, &mut summary),
            }
        }
        let removed = self
            .devices
            .keys()
            .filter(|path| !present.contains(*path))
            .cloned()
            .collect::<Vec<_>>();
        for path in removed {
            if let Some(open) = self.devices.remove(&path) {
                if let Some(event) = matcher.remove_device(open.id) {
                    emitted.push(event);
                }
            }
        }
        (summary, emitted)
    }

    pub fn poll_once<F>(&mut self, matcher: &mut Matcher, mut emit: F) -> io::Result<()>
    where
        F: FnMut(MatchEvent) -> Result<(), String>,
    {
        if self.last_scan.elapsed() >= RESCAN_INTERVAL {
            let (_, events) = self.rescan(matcher);
            for event in events {
                emit(event).map_err(io::Error::other)?;
            }
        }
        for id in self.removed_ids.drain(..) {
            if let Some(event) = matcher.remove_device(id) {
                emit(event).map_err(io::Error::other)?;
            }
        }
        self.events.clear();
        self.poller
            .wait(&mut self.events, Some(Duration::from_millis(100)))?;
        let ready = self
            .events
            .iter()
            .map(|event| event.key)
            .collect::<Vec<_>>();
        for key in ready {
            if key == UDEV_KEY {
                while self.monitor.iter().next().is_some() {}
                let (_, events) = self.rescan(matcher);
                for event in events {
                    emit(event).map_err(io::Error::other)?;
                }
                self.poller.modify_with_mode(
                    &self.monitor,
                    Event::readable(UDEV_KEY),
                    PollMode::Oneshot,
                )?;
                continue;
            }
            let Some(id) = DeviceId::try_from(key - DEVICE_KEY_BASE).ok() else {
                continue;
            };
            let path = self
                .devices
                .iter()
                .find_map(|(path, open)| (open.id == id).then(|| path.clone()));
            let Some(path) = path else { continue };
            let mut remove = false;
            if let Some(open) = self.devices.get_mut(&path) {
                match open.device.fetch_events() {
                    Ok(events) => {
                        for event in events {
                            match event.destructure() {
                                EventSummary::Key(_, key_code, value) => {
                                    if let (Some(code), Some(value)) =
                                        (map_key(key_code), map_value(value))
                                    {
                                        if evdev_debug_enabled() {
                                            eprintln!(
                                                "[slovo-input-helper] evdev input id={id} code={code:?} value={value:?}"
                                            );
                                        }
                                        if let Some(event) = matcher.input(id, code, value) {
                                            if evdev_debug_enabled() {
                                                eprintln!(
                                                    "[slovo-input-helper] matcher emitted generation={} state={:?}",
                                                    event.generation, event.state
                                                );
                                            }
                                            emit(event).map_err(io::Error::other)?;
                                        }
                                    }
                                }
                                EventSummary::Synchronization(_, code, _) if code.0 == 3 => {
                                    if let Some(event) = matcher.sync_dropped(id) {
                                        emit(event).map_err(io::Error::other)?;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    Err(error) if is_normal_removal(&error) => remove = true,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                    Err(error) => return Err(error),
                }
            }
            if remove {
                self.devices.remove(&path);
                if let Some(event) = matcher.remove_device(id) {
                    emit(event).map_err(io::Error::other)?;
                }
            } else if let Some(open) = self.devices.get(&path) {
                self.poller.modify_with_mode(
                    &open.device,
                    Event::readable(key),
                    PollMode::Oneshot,
                )?;
            }
        }
        Ok(())
    }
}

fn classify_open_error(error: &io::Error, summary: &mut ScanSummary) {
    if error.kind() == io::ErrorKind::PermissionDenied {
        summary.permission_denied += 1;
        summary.keyboards += 1;
    }
}

fn is_normal_removal(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOENT | libc::ENODEV | libc::EIO)
    )
}

fn is_keyboard(device: &Device) -> bool {
    device.supported_keys().is_some_and(keyboard_capabilities)
}

fn keyboard_capabilities(keys: &evdev::AttributeSetRef<KeyCode>) -> bool {
    let has_typing_keys = [
        KeyCode::KEY_A,
        KeyCode::KEY_Z,
        KeyCode::KEY_ENTER,
        KeyCode::KEY_SPACE,
    ]
    .into_iter()
    .all(|key| keys.contains(key));
    let has_modifier = [
        KeyCode::KEY_LEFTCTRL,
        KeyCode::KEY_RIGHTCTRL,
        KeyCode::KEY_LEFTALT,
        KeyCode::KEY_RIGHTALT,
        KeyCode::KEY_LEFTSHIFT,
        KeyCode::KEY_RIGHTSHIFT,
        KeyCode::KEY_LEFTMETA,
        KeyCode::KEY_RIGHTMETA,
    ]
    .into_iter()
    .any(|key| keys.contains(key));
    has_typing_keys && has_modifier
}

fn map_value(value: i32) -> Option<InputValue> {
    match value {
        0 => Some(InputValue::Up),
        1 => Some(InputValue::Down),
        2 => Some(InputValue::Repeat),
        _ => None,
    }
}

fn map_key(key: KeyCode) -> Option<InputCode> {
    Some(match key {
        KeyCode::KEY_LEFTCTRL => InputCode::CtrlLeft,
        KeyCode::KEY_RIGHTCTRL => InputCode::CtrlRight,
        KeyCode::KEY_LEFTALT => InputCode::AltLeft,
        KeyCode::KEY_RIGHTALT => InputCode::AltRight,
        KeyCode::KEY_LEFTSHIFT => InputCode::ShiftLeft,
        KeyCode::KEY_RIGHTSHIFT => InputCode::ShiftRight,
        KeyCode::KEY_LEFTMETA => InputCode::SuperLeft,
        KeyCode::KEY_RIGHTMETA => InputCode::SuperRight,
        key if supported_primary_code(key.0) => InputCode::Primary(key.0),
        _ => return None,
    })
}

fn supported_primary_code(code: u16) -> bool {
    matches!(code,
        2..=13 | 14..=28 | 30..=53 | 57 | 59..=68 | 87..=88 |
        102..=111 | 183..=194
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use evdev::AttributeSet;

    fn capabilities(keys: &[KeyCode]) -> AttributeSet<KeyCode> {
        let mut set = AttributeSet::new();
        for key in keys {
            set.insert(*key);
        }
        set
    }

    #[test]
    fn keyboard_predicate_accepts_meta_or_shift_and_rejects_media_pointer_nodes() {
        let typing = [
            KeyCode::KEY_A,
            KeyCode::KEY_Z,
            KeyCode::KEY_ENTER,
            KeyCode::KEY_SPACE,
        ];
        let mut meta = typing.to_vec();
        meta.push(KeyCode::KEY_LEFTMETA);
        assert!(keyboard_capabilities(&capabilities(&meta)));
        let mut shift = typing.to_vec();
        shift.push(KeyCode::KEY_RIGHTSHIFT);
        assert!(keyboard_capabilities(&capabilities(&shift)));
        assert!(!keyboard_capabilities(&capabilities(&[
            KeyCode::BTN_LEFT,
            KeyCode::BTN_RIGHT,
        ])));
        assert!(!keyboard_capabilities(&capabilities(&[
            KeyCode::KEY_VOLUMEUP,
            KeyCode::KEY_VOLUMEDOWN,
            KeyCode::KEY_PLAYPAUSE,
        ])));
    }

    #[test]
    fn maps_modifiers_values_and_rejects_unrelated_codes() {
        assert_eq!(map_key(KeyCode::KEY_LEFTCTRL), Some(InputCode::CtrlLeft));
        assert_eq!(map_key(KeyCode::KEY_RIGHTMETA), Some(InputCode::SuperRight));
        assert_eq!(map_key(KeyCode::KEY_SPACE), Some(InputCode::Primary(57)));
        assert_eq!(map_key(KeyCode::KEY_ESC), None);
        assert_eq!(map_value(0), Some(InputValue::Up));
        assert_eq!(map_value(1), Some(InputValue::Down));
        assert_eq!(map_value(2), Some(InputValue::Repeat));
        assert_eq!(map_value(3), None);
    }

    #[test]
    fn primary_mapping_contains_every_chord_code_and_not_escape() {
        let codes = [
            2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
            26, 27, 28, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 43, 44, 45, 46, 47, 48, 49,
            50, 51, 52, 53, 57, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, 102, 103, 104, 105,
            106, 107, 108, 109, 110, 111, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193,
            194,
        ];
        for code in codes {
            assert_eq!(map_key(KeyCode(code)), Some(InputCode::Primary(code)));
        }
        assert!(!supported_primary_code(KeyCode::KEY_ESC.0));
    }
}
