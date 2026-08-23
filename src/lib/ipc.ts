/**
 * The IPC contract between the frontend and the Rust backend: Tauri command
 * names registered in `src-tauri/src/app.rs` (`invoke_handler`) and event
 * names emitted by the backend. Both windows (settings app and recording
 * overlay) import from here so a rename can never desync the two sides.
 */

export const Commands = {
  getSettings: "get_settings",
  updateSettings: "update_settings",
  getStatus: "get_status",
  listInputDevices: "list_input_devices",
  checkServerUrl: "check_server_url",
  setHotkeyCaptureActive: "set_hotkey_capture_active",
  retryShortcutBackend: "retry_shortcut_backend",
  getShortcutBackendStatus: "get_shortcut_backend_status",
  getShortcutPermissionSetup: "get_shortcut_permission_setup",
} as const;

export const Events = {
  status: "slovo://status",
  shortcutStatus: "slovo://shortcut-status",
  audioLevel: "slovo://audio-level",
} as const;
