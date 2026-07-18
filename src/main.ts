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

type ShortcutBackend = "native" | "wayland-helper" | "legacy-portal";

interface ShortcutBackendStatusPayload {
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

type ShortcutViewState =
  | "idle"
  | "preparing"
  | "active"
  | "warning"
  | "error"
  | "neutral";

interface ShortcutPermissionSetup {
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
const shortcutStatus = requiredElement<HTMLElement>("#shortcut-status");
const shortcutStatusText = requiredElement<HTMLElement>("#shortcut-status-text");
const shortcutStatusMark = requiredElement<HTMLElement>("#shortcut-status-mark");
const shortcutRetry = requiredElement<HTMLButtonElement>("#shortcut-retry");
const shortcutSetup = requiredElement<HTMLButtonElement>("#shortcut-setup");
const permissionDialog = requiredElement<HTMLDialogElement>("#permission-dialog");
const permissionDialogContent = requiredElement<HTMLElement>("#permission-dialog-content");
const permissionDialogLoading = requiredElement<HTMLElement>("#permission-dialog-loading");
const permissionDialogState = requiredElement<HTMLElement>("#permission-dialog-state");
const permissionDialogClose = requiredElement<HTMLButtonElement>("#permission-dialog-close");
const permissionCancel = requiredElement<HTMLButtonElement>("#permission-cancel");
const permissionVerify = requiredElement<HTMLButtonElement>("#permission-verify");
const permissionAck = requiredElement<HTMLInputElement>("#permission-ack");
const permissionInstallStatus = requiredElement<HTMLElement>("#permission-install-status");
const permissionSetupError = requiredElement<HTMLElement>("#permission-setup-error");
const permissionInstallCode = requiredElement<HTMLElement>("#permission-install-code");
const permissionRevokeCode = requiredElement<HTMLElement>("#permission-revoke-code");
const permissionRevokeNote = requiredElement<HTMLElement>("#permission-revoke-note");
const permissionCopyInstall = requiredElement<HTMLButtonElement>("#permission-copy-install");
const permissionCopyRevoke = requiredElement<HTMLButtonElement>("#permission-copy-revoke");
const saveState = requiredElement<HTMLElement>("#save-state");
let isShortcutRetryPending = false;
let isPermissionLoading = false;
let lastPermissionSetup: ShortcutPermissionSetup | null = null;
let lastFocusedBeforeDialog: HTMLElement | null = null;
let permissionSetupAllowed = false;

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

const shortcutDeviceLabel = (count?: number): string => {
  if (!count || count <= 0) return "";
  const lastTwo = count % 100;
  const last = count % 10;
  const word = lastTwo >= 11 && lastTwo <= 14
    ? "устройств"
    : last === 1
      ? "устройство"
      : last >= 2 && last <= 4
        ? "устройства"
        : "устройств";
  return ` · ${count} ${word}`;
};

function renderShortcutStatus(payload: ShortcutBackendStatusPayload): void {
  const state = payload.state;
  const backend = payload.backend;
  const isLegacy = backend === "legacy-portal";

  let view: ShortcutViewState;
  let text: string;
  let canRetry = false;
  let canSetup = false;

  switch (state) {
    case "starting":
    case "restarting":
      view = "preparing";
      text = isLegacy
        ? "Запускаем системное сочетание…"
        : "Готовим глобальное сочетание…";
      break;
    case "active":
      view = "active";
      text = isLegacy
        ? "Системное сочетание активно"
        : `Сочетание активно${shortcutDeviceLabel(payload.deviceCount)}`;
      break;
    case "permission-denied":
      view = "warning";
      canRetry = true;
      canSetup = !!payload.setupAvailable;
      text = canSetup
        ? "Нет доступа к клавиатуре. В Wayland для глобального сочетания нужно разрешить чтение устройств ввода — тогда Слово видит только нажатия назначенного сочетания. Откройте «Настроить доступ», чтобы разрешить, или повторите попытку."
        : "Нет доступа к клавиатуре. В Wayland для глобального сочетания нужно разрешить чтение устройств ввода. Повторите попытку.";
      break;
    case "devices-unavailable":
      view = "warning";
      canRetry = true;
      text =
        "Не нашли подходящих устройств ввода. Проверьте, что клавиатура подключена и доступна для чтения, и повторите попытку.";
      break;
    case "failed":
      view = "error";
      canRetry = true;
      text = payload.detail?.trim()
        ? `Не удалось запустить сочетание: ${payload.detail.trim()}`
        : "Не удалось запустить сочетание. Повторите попытку.";
      break;
    case "shutting-down":
      view = "neutral";
      text = "Завершаем работу…";
      break;
    default:
      view = "neutral";
      text = "Состояние сочетания неизвестно.";
      break;
  }

  shortcutStatus.dataset.state = view;
  shortcutStatusText.textContent = text;
  shortcutStatusMark.textContent = "";
  permissionSetupAllowed = canSetup;
  shortcutRetry.hidden = !canRetry;
  shortcutSetup.hidden = !canSetup;
  if (!canSetup && permissionDialog.open) {
    closePermissionDialog();
  }
  shortcutStatus.setAttribute(
    "aria-busy",
    state === "starting" || state === "restarting" ? "true" : "false",
  );
}

async function retryShortcutBackend(): Promise<void> {
  if (isShortcutRetryPending) return;
  isShortcutRetryPending = true;
  shortcutRetry.disabled = true;
  shortcutRetry.setAttribute("aria-busy", "true");
  try {
    const status = await invoke<ShortcutBackendStatusPayload>(
      "retry_shortcut_backend",
    );
    renderShortcutStatus(status);
    hideError();
  } catch (error) {
    showError(
      getErrorMessage(error, "Не удалось перезапустить сочетание."),
      retryShortcutBackend,
    );
  } finally {
    isShortcutRetryPending = false;
    shortcutRetry.disabled = false;
    shortcutRetry.removeAttribute("aria-busy");
  }
}

async function loadShortcutStatus(): Promise<void> {
  try {
    const status = await invoke<ShortcutBackendStatusPayload>(
      "get_shortcut_backend_status",
    );
    renderShortcutStatus(status);
  } catch (error) {
    renderShortcutStatus({ state: "failed", detail: "" });
    showError(
      getErrorMessage(error, "Не удалось получить состояние сочетания."),
      loadShortcutStatus,
    );
  }
}

function setPermissionDialogState(message: string, hidden = !message): void {
  permissionDialogState.textContent = message;
  permissionDialogState.hidden = hidden;
}

function renderPermissionSetup(setup: ShortcutPermissionSetup): void {
  lastPermissionSetup = setup;
  const commands = (setup.installCommands ?? []).filter((line) => line && line.trim());
  const revoke = (setup.revokeCommands ?? []).filter((line) => line && line.trim());

  const setupError = setup.setupError?.trim();
  if (setupError) {
    permissionSetupError.textContent = setupError;
    permissionSetupError.hidden = false;
  } else {
    permissionSetupError.textContent = "";
    permissionSetupError.hidden = true;
  }

  permissionInstallStatus.textContent = setup.installed
    ? "Доступ уже настроен. Если сочетание всё ещё не работает, проверьте его снова."
    : "Доступ ещё не настроен.";

  const installCode = permissionInstallCode.querySelector("code");
  if (installCode) installCode.textContent = commands.join("\n");
  permissionInstallCode.hidden = commands.length === 0;

  const revokeCode = permissionRevokeCode.querySelector("code");
  if (revokeCode) revokeCode.textContent = revoke.join("\n");
  // Revoke never needs the prepared file, so it is always shown.
  permissionRevokeCode.hidden = revoke.length === 0;

  const note = setup.note?.trim();
  permissionRevokeNote.textContent = note
    ? note
    : "Эти команды вернут настройки доступа к устройствам ввода обратно.";
  permissionRevokeNote.hidden = !note && revoke.length === 0;

  permissionCopyRevoke.disabled = revoke.length === 0;
  updateInstallAckGate();
}

function updateInstallAckGate(): void {
  const acknowledged = permissionAck.checked;
  const hasInstallCommands = !!lastPermissionSetup?.installCommands?.some(
    (line) => line && line.trim(),
  );
  permissionCopyInstall.disabled = !acknowledged || !hasInstallCommands;
}

async function loadPermissionSetup(): Promise<void> {
  if (isPermissionLoading) return;
  isPermissionLoading = true;
  lastPermissionSetup = null;
  permissionAck.checked = false;
  const installCode = permissionInstallCode.querySelector("code");
  if (installCode) installCode.textContent = "";
  permissionInstallCode.hidden = true;
  const revokeCode = permissionRevokeCode.querySelector("code");
  if (revokeCode) revokeCode.textContent = "";
  permissionRevokeCode.hidden = true;
  permissionSetupError.textContent = "";
  permissionSetupError.hidden = true;
  permissionCopyInstall.disabled = true;
  permissionCopyRevoke.disabled = true;
  permissionDialogLoading.hidden = false;
  permissionDialogContent.hidden = true;
  setPermissionDialogState("");
  permissionVerify.disabled = true;
  try {
    const setup = await invoke<ShortcutPermissionSetup>(
      "get_shortcut_permission_setup",
    );
    if (setup.supported === false) {
      setPermissionDialogState(
        "Настройка доступа не поддерживается в этой системе. " +
          "Глобальное сочетание может быть недоступно.",
      );
    } else {
      renderPermissionSetup(setup);
      permissionDialogContent.hidden = false;
    }
  } catch (error) {
    lastPermissionSetup = null;
    permissionDialogContent.hidden = true;
    setPermissionDialogState(
      getErrorMessage(
        error,
        "Не удалось загрузить инструкции по настройке доступа.",
      ),
      false,
    );
  } finally {
    permissionDialogLoading.hidden = true;
    permissionVerify.disabled = false;
    isPermissionLoading = false;
  }
}

function openPermissionDialog(): void {
  if (!permissionSetupAllowed || shortcutSetup.hidden) return;
  permissionDialog.hidden = false;
  if (typeof permissionDialog.showModal === "function") {
    if (!permissionDialog.open) {
      lastFocusedBeforeDialog = document.activeElement as HTMLElement | null;
      permissionDialog.showModal();
    }
  } else {
    lastFocusedBeforeDialog = document.activeElement as HTMLElement | null;
    permissionDialog.setAttribute("open", "");
    permissionDialog.hidden = false;
  }
  permissionAck.checked = false;
  updateInstallAckGate();
  void loadPermissionSetup();
  const focusTarget = permissionDialogClose as HTMLElement;
  window.setTimeout(() => focusTarget.focus(), 0);
}

function closePermissionDialog(): void {
  if (typeof permissionDialog.close === "function" && permissionDialog.open) {
    permissionDialog.close();
  }
  permissionDialog.removeAttribute("open");
  permissionDialog.hidden = true;
  lastPermissionSetup = null;
  permissionAck.checked = false;
  const installCode = permissionInstallCode.querySelector("code");
  if (installCode) installCode.textContent = "";
  permissionInstallCode.hidden = true;
  const revokeCode = permissionRevokeCode.querySelector("code");
  if (revokeCode) revokeCode.textContent = "";
  permissionRevokeCode.hidden = true;
  permissionDialogContent.hidden = true;
  permissionDialogLoading.hidden = true;
  permissionCopyInstall.disabled = true;
  permissionCopyRevoke.disabled = true;
  setPermissionDialogState("");
  if (lastFocusedBeforeDialog) {
    lastFocusedBeforeDialog.focus();
    lastFocusedBeforeDialog = null;
  }
}

async function copyPermissionCommands(kind: "install" | "revoke"): Promise<void> {
  if (!lastPermissionSetup) return;
  const source = kind === "install"
    ? lastPermissionSetup.installCommands
    : lastPermissionSetup.revokeCommands;
  const commands = (source ?? []).filter((line) => line && line.trim());
  if (commands.length === 0) return;

  const text = commands.join("\n");
  const button = kind === "install" ? permissionCopyInstall : permissionCopyRevoke;
  const originalLabel = button.textContent;
  button.disabled = true;

  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand("copy");
      document.body.removeChild(textarea);
    } catch {
      copied = false;
    }
  }

  button.textContent = copied ? "Скопировано" : "Не удалось скопировать";
  setPermissionDialogState(
    copied
      ? "Команды скопированы в буфер обмена."
      : "Не удалось скопировать. Выделите команды вручную.",
  );
  window.setTimeout(() => {
    button.textContent = originalLabel;
    button.disabled = kind === "install" ? !permissionAck.checked : false;
  }, 2200);
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

shortcutRetry.addEventListener("click", () => void retryShortcutBackend());

shortcutSetup.addEventListener("click", openPermissionDialog);

permissionDialogClose.addEventListener("click", closePermissionDialog);
permissionCancel.addEventListener("click", closePermissionDialog);

permissionDialog.addEventListener("click", (event) => {
  if (event.target === permissionDialog) {
    closePermissionDialog();
  }
});

permissionDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closePermissionDialog();
});

permissionAck.addEventListener("change", updateInstallAckGate);

permissionCopyInstall.addEventListener("click", () =>
  void copyPermissionCommands("install"),
);
permissionCopyRevoke.addEventListener("click", () =>
  void copyPermissionCommands("revoke"),
);

permissionVerify.addEventListener("click", () => {
  closePermissionDialog();
  void retryShortcutBackend();
});

window.addEventListener("DOMContentLoaded", async () => {
  closePermissionDialog();
  permissionSetupAllowed = false;
  shortcutSetup.hidden = true;
  await loadSettings();
  try {
    await populateDeviceSelect();
  } catch (error) {
    showError(getErrorMessage(error, "Не удалось получить список устройств ввода."));
  }

  void loadShortcutStatus();
  try {
    await listen<ShortcutBackendStatusPayload>("slovo://shortcut-status", ({ payload }) => {
      renderShortcutStatus(payload);
    });
  } catch (error) {
    showError(getErrorMessage(error, "Не удалось подключить отображение состояния сочетания."));
  }

  try {
    await listen<StatusPayload>("slovo://status", ({ payload }) => setStatus(payload));
  } catch (error) {
    showError(getErrorMessage(error, "Не удалось подключить отображение состояния."));
  }
});
