export type TriggerType = "toggle" | "hold" | "auto-vad";

export type StatusKind =
  | "ready"
  | "recording"
  | "transcribing"
  | "inserted"
  | "copied"
  | "error";

export interface Settings {
  hotkey: string;
  serverUrl: string;
  triggerType: TriggerType;
  inputDevice: string | null;
}

export interface InputDevice {
  value: string;
  label: string;
  isDefault: boolean;
}

export interface StatusPayload {
  kind: StatusKind;
  message?: string;
  elapsedSeconds?: number;
}

export type ShortcutBackend = "native" | "wayland-helper" | "legacy-portal";

export interface ShortcutBackendStatusPayload {
  state:
    | "starting"
    | "active"
    | "permission-denied"
    | "devices-unavailable"
    | "restarting"
    | "failed"
    | "shutting-down";
  backend?: ShortcutBackend;
  shortcut?: string;
  deviceCount?: number;
  detail?: string;
  setupAvailable?: boolean;
}

export type ShortcutViewState =
  | "idle"
  | "preparing"
  | "active"
  | "warning"
  | "error"
  | "neutral";

export interface ShortcutPermissionSetup {
  supported?: boolean;
  disclosure?: string;
  installed?: boolean;
  destination?: string;
  preparedRulePath?: string | null;
  installCommands?: string[];
  revokeCommands?: string[];
  note?: string;
  setupError?: string;
}

export type SaveKind = "idle" | "saving" | "saved" | "error";

export const DEFAULT_SETTINGS: Settings = {
  hotkey: "Control+Shift+Space",
  serverUrl: "http://127.0.0.1:8072",
  triggerType: "toggle",
  inputDevice: null,
};

export const triggerDescriptions: Record<TriggerType, string> = {
  toggle: "Нажмите один раз для начала и ещё раз для остановки.",
  hold: "Говорите, пока удерживаете сочетание клавиш.",
  "auto-vad": "Запись остановится автоматически, когда речь закончится.",
};

export function normalizeTriggerType(value: string): TriggerType {
  if (value === "hold" || value === "auto-vad") return value;
  return "toggle";
}

export function normalizeSettings(
  value: Partial<Settings> | null | undefined,
): Settings {
  const raw = value as
    | (Partial<Settings> & {
        server_url?: string;
        trigger_type?: string;
        input_device?: string | null;
      })
    | null
    | undefined;

  return {
    hotkey: raw?.hotkey?.trim() || DEFAULT_SETTINGS.hotkey,
    serverUrl: (raw?.serverUrl ?? raw?.server_url ?? "").trim(),
    triggerType: normalizeTriggerType(
      raw?.triggerType ?? raw?.trigger_type ?? "toggle",
    ),
    inputDevice: raw?.inputDevice ?? raw?.input_device ?? null,
  };
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function formatElapsed(seconds = 0): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}
