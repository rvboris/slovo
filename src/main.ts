import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type TriggerType = "toggle" | "hold" | "auto-vad";
type StatusKind =
  | "ready"
  | "recording"
  | "transcribing"
  | "inserted"
  | "copied"
  | "error";

interface Settings {
  hotkey: string;
  serverUrl: string;
  triggerType: TriggerType;
  inputDevice: string | null;
}

interface InputDevice {
  value: string;
  label: string;
  isDefault: boolean;
}

interface StatusPayload {
  kind: StatusKind;
  message?: string;
  elapsedSeconds?: number;
}

const DEFAULT_SETTINGS: Settings = {
  hotkey: "Control+Shift+Space",
  serverUrl: "http://127.0.0.1:8072",
  triggerType: "toggle",
  inputDevice: null,
};

const triggerDescriptions: Record<TriggerType, string> = {
  toggle: "Нажмите один раз для начала и ещё раз для остановки.",
  hold: "Говорите, пока удерживаете сочетание клавиш.",
  "auto-vad": "Запись остановится автоматически, когда речь закончится.",
};

const modifierOrder = ["Ctrl", "Alt", "Shift", "Super"] as const;
const modifierKeys: Record<string, (typeof modifierOrder)[number]> = {
  Control: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Meta: "Super",
};

let settings: Settings = { ...DEFAULT_SETTINGS };
let persistedSettings: Settings = { ...DEFAULT_SETTINGS };
let serverSaveTimer: number | undefined;
let isCapturingHotkey = false;
let lastFailedAction: (() => Promise<void>) | null = null;
let insertedStatusTimer: number | undefined;
let saveRevision = 0;
let saveQueue: Promise<void> = Promise.resolve();

const requiredElement = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Не найден элемент ${selector}`);
  return element;
};

const form = requiredElement<HTMLFormElement>("#settings-form");
const hotkeyControl = requiredElement<HTMLButtonElement>("#hotkey-control");
const hotkeyValue = requiredElement<HTMLElement>("#hotkey-value");
const hotkeyHelp = requiredElement<HTMLElement>("#hotkey-help");
const serverUrl = requiredElement<HTMLInputElement>("#server-url");
const inputDevice = requiredElement<HTMLSelectElement>("#input-device");
const serverError = requiredElement<HTMLElement>("#server-error");
const triggerHelp = requiredElement<HTMLElement>("#trigger-help");
const status = requiredElement<HTMLElement>("#status");
const statusText = requiredElement<HTMLElement>("#status-text");
const errorBanner = requiredElement<HTMLElement>("#error-banner");
const errorMessage = requiredElement<HTMLElement>("#error-message");
const retryButton = requiredElement<HTMLButtonElement>("#retry-button");
const overlayDebugToggle = requiredElement<HTMLButtonElement>("#overlay-debug-toggle");
const saveState = requiredElement<HTMLElement>("#save-state");
let isOverlayDebugVisible = false;

function normalizeTriggerType(value: string): TriggerType {
  if (value === "hold" || value === "auto-vad") return value;
  return "toggle";
}

function normalizeSettings(value: Partial<Settings> | null | undefined): Settings {
  const raw = value as (Partial<Settings> & {
    server_url?: string;
    trigger_type?: string;
    input_device?: string | null;
  }) | null | undefined;

  return {
    hotkey: raw?.hotkey?.trim() || DEFAULT_SETTINGS.hotkey,
    serverUrl: (raw?.serverUrl ?? raw?.server_url ?? "").trim(),
    triggerType: normalizeTriggerType(raw?.triggerType ?? raw?.trigger_type ?? "toggle"),
    inputDevice: raw?.inputDevice ?? raw?.input_device ?? null,
  };
}

function displayKey(key: string): string {
  const names: Record<string, string> = {
    " ": "Space",
    Spacebar: "Space",
    Escape: "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Enter: "Enter",
    Backspace: "Backspace",
    Delete: "Delete",
    Tab: "Tab",
    Backquote: "Ё / `",
  };

  if (names[key]) return names[key];
  if (/^Key[A-Z]$/.test(key)) return key.slice(3);
  if (/^Digit[0-9]$/.test(key)) return key.slice(5);
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function hotkeyCode(event: KeyboardEvent): string | null {
  if (/^(Key[A-Z]|Digit[0-9])$/.test(event.code)) return event.code;
  if (event.code && event.code !== "Unidentified") return event.code;
  return null;
}

function isSupportedHotkeyCode(code: string): boolean {
  return /^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(code)
    || [
      "Backquote", "Backslash", "BracketLeft", "BracketRight", "Comma", "Equal",
      "Minus", "Period", "Quote", "Semicolon", "Slash", "Backspace", "Delete",
      "End", "Enter", "Home", "Insert", "PageDown", "PageUp", "Space", "Tab",
      "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp",
    ].includes(code);
}

function formatHotkey(event: KeyboardEvent): string | null {
  if (modifierKeys[event.key]) return null;
  const key = hotkeyCode(event);
  if (!key || !isSupportedHotkeyCode(key)) return null;

  const modifiers = modifierOrder.filter((modifier) => {
    if (modifier === "Ctrl") return event.ctrlKey;
    if (modifier === "Alt") return event.altKey;
    if (modifier === "Shift") return event.shiftKey;
    return event.metaKey;
  });

  if (modifiers.length === 0) return null;
  return [...modifiers, key].join("+");
}

function renderHotkey(value: string): void {
  hotkeyValue.replaceChildren();
  const parts = value.split("+").filter(Boolean);

  parts.forEach((part, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "key-separator";
      separator.textContent = "+";
      separator.setAttribute("aria-hidden", "true");
      hotkeyValue.append(separator);
    }

    const key = document.createElement("kbd");
    key.textContent = part === "Meta" || part === "Super"
      ? (navigator.platform.includes("Mac") ? "⌘" : "Super")
      : displayKey(part);
    hotkeyValue.append(key);
  });
}

function renderSettings(): void {
  renderHotkey(settings.hotkey);
  serverUrl.value = settings.serverUrl;
  const selectedTrigger = form.querySelector<HTMLInputElement>(
    `input[name="triggerType"][value="${settings.triggerType}"]`,
  );
  if (selectedTrigger) selectedTrigger.checked = true;
  triggerHelp.textContent = triggerDescriptions[settings.triggerType];
  inputDevice.value = settings.inputDevice ?? "";
}

async function populateDeviceSelect(): Promise<void> {
  const devices = await invoke<InputDevice[]>("list_input_devices");
  const current = settings.inputDevice ?? "";
  inputDevice.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Системное по умолчанию";
  inputDevice.appendChild(defaultOption);
  let found = !current;
  for (const dev of devices) {
    const opt = document.createElement("option");
    opt.value = dev.value;
    opt.textContent = dev.label;
    inputDevice.appendChild(opt);
    if (dev.value === current) found = true;
  }
  if (!found && current) {
    const opt = document.createElement("option");
    opt.value = current;
    opt.textContent = `Недоступно: ${current}`;
    inputDevice.appendChild(opt);
  }
  inputDevice.value = current;
}

function formatElapsed(seconds = 0): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function setStatus(payload: StatusPayload): void {
  if (insertedStatusTimer) window.clearTimeout(insertedStatusTimer);

  const labels: Record<StatusKind, string> = {
    ready: "Готово",
    recording: `Слушаю · ${formatElapsed(payload.elapsedSeconds)}`,
    transcribing: "Распознаю…",
    inserted: "Текст вставлен",
    copied: "Скопировано",
    error: "Ошибка",
  };

  status.dataset.kind = payload.kind;
  statusText.textContent = payload.message || labels[payload.kind];

  if (payload.kind === "error") {
    showError(payload.message || "Не удалось выполнить действие.", lastFailedAction ?? undefined);
  } else {
    hideError();
  }

  if (payload.kind === "inserted" || payload.kind === "copied") {
    insertedStatusTimer = window.setTimeout(() => setStatus({ kind: "ready" }), 2400);
  }
}

function showError(message: string, retry?: () => Promise<void>): void {
  errorMessage.textContent = message;
  lastFailedAction = retry ?? null;
  retryButton.hidden = !lastFailedAction;
  errorBanner.hidden = false;
}

function hideError(): void {
  errorBanner.hidden = true;
}

function setSaveState(text: string, kind: "idle" | "saving" | "saved" | "error" = "idle"): void {
  saveState.textContent = text;
  saveState.parentElement?.setAttribute("data-save-kind", kind);
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function saveSettings(nextSettings: Settings): Promise<void> {
  const requested = { ...nextSettings };
  const revision = ++saveRevision;
  settings = requested;
  setSaveState("Сохраняю…", "saving");
  hideError();

  const operation = saveQueue.then(async () => {
    try {
      const saved = normalizeSettings(
        await invoke<Settings>("update_settings", { settings: requested }),
      );
      persistedSettings = saved;

      if (revision === saveRevision) {
        settings = saved;
        renderHotkey(saved.hotkey);
        const selectedTrigger = form.querySelector<HTMLInputElement>(
          `input[name="triggerType"][value="${saved.triggerType}"]`,
        );
        if (selectedTrigger) selectedTrigger.checked = true;
        triggerHelp.textContent = triggerDescriptions[saved.triggerType];
        if (document.activeElement !== serverUrl) serverUrl.value = saved.serverUrl;
        setSaveState("Изменения сохранены", "saved");
        lastFailedAction = null;
        window.setTimeout(() => {
          if (revision === saveRevision && saveState.textContent === "Изменения сохранены") {
            setSaveState("Изменения сохраняются автоматически");
          }
        }, 1800);
      }
    } catch (error) {
      if (revision === saveRevision) {
        settings = { ...persistedSettings };
        renderSettings();
        setSaveState("Не удалось сохранить", "error");
        showError(
          getErrorMessage(error, "Не удалось сохранить настройки."),
          () => saveSettings(requested),
        );
      }
      throw error;
    }
  });

  saveQueue = operation.catch(() => undefined);
  return operation;
}

async function retryLastAction(): Promise<void> {
  if (!lastFailedAction) return;
  retryButton.disabled = true;
  try {
    await lastFailedAction();
  } catch {
    // The action already presents a useful error to the user.
  } finally {
    retryButton.disabled = false;
  }
}

function validateServerUrl(): string | null {
  const value = serverUrl.value.trim();
  if (!value) return "Укажите адрес сервера.";

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    return "Введите полный адрес, включая http:// или https://.";
  }

  return null;
}

function showServerValidation(): boolean {
  const message = validateServerUrl();
  serverError.textContent = message ?? "";
  serverUrl.setAttribute("aria-invalid", message ? "true" : "false");
  return !message;
}

function scheduleServerSave(): void {
  if (serverSaveTimer) window.clearTimeout(serverSaveTimer);
  serverError.textContent = "";
  serverUrl.removeAttribute("aria-invalid");

  serverSaveTimer = window.setTimeout(() => {
    serverSaveTimer = undefined;
    if (!showServerValidation()) return;
    void saveSettings({ ...settings, serverUrl: serverUrl.value.trim() }).catch(() => undefined);
  }, 400);
}

function beginHotkeyCapture(): void {
  isCapturingHotkey = true;
  hotkeyControl.classList.add("is-capturing");
  hotkeyControl.setAttribute("aria-pressed", "true");
  hotkeyValue.textContent = "Нажмите сочетание…";
  hotkeyHelp.textContent = "Escape — отменить. Добавьте Ctrl, Alt, Shift или Super к обычной клавише.";
}

function endHotkeyCapture(): void {
  isCapturingHotkey = false;
  hotkeyControl.classList.remove("is-capturing");
  hotkeyControl.setAttribute("aria-pressed", "false");
  hotkeyHelp.textContent = "Нажмите поле, затем новое сочетание. Escape — отменить.";
  renderHotkey(settings.hotkey);
}

async function loadSettings(): Promise<void> {
  try {
    settings = normalizeSettings(await invoke<Settings>("get_settings"));
    persistedSettings = { ...settings };
    renderSettings();
  } catch (error) {
    renderSettings();
    showError(
      getErrorMessage(error, "Не удалось загрузить настройки."),
      loadSettings,
    );
  }
}

hotkeyControl.addEventListener("click", () => {
  if (isCapturingHotkey) endHotkeyCapture();
  else beginHotkeyCapture();
});

hotkeyControl.addEventListener("keydown", (event) => {
  if (!isCapturingHotkey) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.key === "Escape") {
    endHotkeyCapture();
    return;
  }

  const hotkey = formatHotkey(event);
  if (!hotkey) {
    hotkeyValue.textContent = modifierKeys[event.key]
      ? "Добавьте клавишу…"
      : "Нужно поддерживаемое сочетание";
    return;
  }

  settings = { ...settings, hotkey };
  endHotkeyCapture();
  void saveSettings(settings).catch(() => undefined);
});

serverUrl.addEventListener("input", scheduleServerSave);
serverUrl.addEventListener("blur", () => {
  if (serverSaveTimer) window.clearTimeout(serverSaveTimer);
  serverSaveTimer = undefined;
  if (!showServerValidation()) return;
  const value = serverUrl.value.trim();
  if (value !== settings.serverUrl) {
    void saveSettings({ ...settings, serverUrl: value }).catch(() => undefined);
  }
});

form.addEventListener("change", (event) => {
  const target = event.target;
  if (target === inputDevice) {
    settings = { ...settings, inputDevice: inputDevice.value || null };
    void saveSettings(settings).catch(() => undefined);
    return;
  }
  if (!(target instanceof HTMLInputElement) || target.name !== "triggerType") return;

  const triggerType = normalizeTriggerType(target.value);
  settings = { ...settings, triggerType };
  triggerHelp.textContent = triggerDescriptions[triggerType];
  void saveSettings(settings).catch(() => undefined);
});

retryButton.addEventListener("click", () => void retryLastAction());

// Temporary diagnostic control: bypass recording/hotkey/status and address the
// recording overlay window directly so Wayland mapping failures are visible.
overlayDebugToggle.addEventListener("click", async () => {
  const nextVisible = !isOverlayDebugVisible;
  overlayDebugToggle.disabled = true;
  try {
    await invoke("set_recording_overlay_visible", { visible: nextVisible });
    isOverlayDebugVisible = nextVisible;
    overlayDebugToggle.textContent = nextVisible
      ? "Скрыть индикатор"
      : "Показать индикатор";
    hideError();
  } catch (error) {
    showError(getErrorMessage(error, "Не удалось изменить видимость индикатора."));
  } finally {
    overlayDebugToggle.disabled = false;
  }
});

window.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  try {
    await populateDeviceSelect();
  } catch (error) {
    showError(getErrorMessage(error, "Не удалось получить список устройств ввода."));
  }

  try {
    await listen<StatusPayload>("slovo://status", ({ payload }) => setStatus(payload));
  } catch (error) {
    showError(getErrorMessage(error, "Не удалось подключить отображение состояния."));
  }
});
