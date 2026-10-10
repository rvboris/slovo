type TriggerType = "toggle" | "hold" | "auto-vad";

type StatusKind =
  | "ready"
  | "recording"
  | "transcribing"
  | "correcting"
  | "inserted"
  | "copied"
  | "error";

interface Settings {
  readonly hotkey: string;
  readonly serverUrl: string;
  readonly triggerType: TriggerType;
  readonly inputDevice: string | null;
  readonly llmServerUrl: string | null;
  readonly llmModel: string | null;
  readonly llmApiKey: string | null;
  readonly llmPrompt: string | null;
}

interface InputDevice {
  readonly name: string;
  readonly isDefault: boolean;
}

interface StatusPayload {
  readonly revision: number;
  readonly correctionWarning?: string;
  readonly kind: StatusKind;
  readonly message?: string;
  readonly elapsedSeconds?: number;
}

type ShortcutBackend = "native" | "wayland-helper";

interface ShortcutBackendStatusPayload {
  readonly state:
    | "starting"
    | "active"
    | "permission-denied"
    | "devices-unavailable"
    | "restarting"
    | "failed"
    | "shutting-down";
  readonly backend?: ShortcutBackend;
  readonly shortcut?: string;
  readonly deviceCount?: number;
  readonly detail?: string;
  readonly setupAvailable?: boolean;
}

type ShortcutViewState = "idle" | "preparing" | "active" | "warning" | "error" | "neutral";

interface ShortcutPermissionSetup {
  readonly supported?: boolean;
  readonly disclosure?: string;
  readonly installed?: boolean;
  readonly destination?: string;
  readonly preparedRulePath?: string | null;
  readonly installCommands?: readonly string[];
  readonly revokeCommands?: readonly string[];
  readonly note?: string;
  readonly setupError?: string;
}

const DEFAULT_SETTINGS: Settings = {
  hotkey: "Control+Shift+Space",
  inputDevice: null,
  llmApiKey: null,
  llmModel: null,
  llmPrompt: null,
  llmServerUrl: null,
  serverUrl: "http://127.0.0.1:8072",
  triggerType: "toggle",
};

const triggerDescriptions: Record<TriggerType, string> = {
  "auto-vad": "Запись остановится автоматически, когда речь закончится.",
  hold: "Говорите, пока удерживаете сочетание клавиш.",
  toggle: "Нажмите один раз для начала и ещё раз для остановки.",
};

function normalizeTriggerType(value: string): TriggerType {
  if (value === "hold" || value === "auto-vad") {
    return value;
  }
  return "toggle";
}

function normalizeSettings(
  value:
    | Readonly<
        Partial<Settings> & {
          input_device?: string | null;
          server_url?: string;
          trigger_type?: string;
        }
      >
    | null
    | undefined,
): Settings {
  const raw = value ?? {};
  let hotkey = raw.hotkey?.trim() ?? "";
  if (hotkey === "") {
    ({ hotkey } = DEFAULT_SETTINGS);
  }

  return {
    hotkey,
    inputDevice: raw.inputDevice ?? raw.input_device ?? null,
    llmApiKey: raw.llmApiKey ?? null,
    llmModel: raw.llmModel ?? null,
    llmPrompt: raw.llmPrompt ?? null,
    llmServerUrl: raw.llmServerUrl ?? null,
    serverUrl: (raw.serverUrl ?? raw.server_url ?? "").trim(),
    triggerType: normalizeTriggerType(raw.triggerType ?? raw.trigger_type ?? "toggle"),
  };
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim() !== "") {
    return error;
  }
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return fallback;
}

const INITIAL_SECONDS = 0;
const SECONDS_PER_MINUTE = 60;
const CLOCK_FIELD_WIDTH = 2;
function formatElapsed(seconds = INITIAL_SECONDS): string {
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE)
    .toString()
    .padStart(CLOCK_FIELD_WIDTH, "0");
  const remainder = Math.floor(seconds % SECONDS_PER_MINUTE)
    .toString()
    .padStart(CLOCK_FIELD_WIDTH, "0");
  return `${minutes}:${remainder}`;
}

export {
  DEFAULT_SETTINGS,
  formatElapsed,
  getErrorMessage,
  normalizeSettings,
  normalizeTriggerType,
  triggerDescriptions,
  type InputDevice,
  type Settings,
  type ShortcutBackend,
  type ShortcutBackendStatusPayload,
  type ShortcutPermissionSetup,
  type ShortcutViewState,
  type StatusKind,
  type StatusPayload,
  type TriggerType,
};
