import { DEFAULT_SETTINGS, getErrorMessage, normalizeSettings } from "@/lib/types";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "@/lib/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const SAVE_DELAY_MS = 400;
const INITIAL_REVISION = 0;
const REVISION_STEP = 1;

async function acceptReportedFailure(operation: Readonly<Promise<void>>): Promise<void> {
  try {
    await operation;
  } catch {
    // SaveSettings already presents the failure; detached callers must consume it.
  }
}

function validServerUrl(value: string): string | null {
  try {
    const trimmed = value.trim();
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return trimmed;
    }
  } catch {
    // Incomplete edits are not persisted.
  }
  return null;
}

interface UseSettingsOptions {
  onError: (message: string, retry?: () => Promise<void>) => void;
  onClearError: () => void;
}

interface SettingsResult {
  isLoaded: boolean;
  loadSettings: () => Promise<void>;
  saveMessage: string;
  saveServerNow: (value: string) => void;
  saveSettings: (patch: Readonly<Partial<Settings>>) => Promise<void>;
  scheduleServerSave: (value: string) => void;
  setSettings: Dispatch<SetStateAction<Settings>>;
  settings: Settings;
  updateSetting: <Key extends keyof Settings>(key: Key, value: Settings[Key]) => void;
}
type SettingsData = Omit<SettingsResult, "saveServerNow" | "scheduleServerSave" | "updateSetting">;

type SettingsRuntime = Readonly<{
  persistedRef: RefObject<Settings>;
  queueRef: RefObject<Promise<void>>;
  revisionRef: RefObject<number>;
  setSettings: Dispatch<SetStateAction<Settings>>;
  onError: UseSettingsOptions["onError"];
}>;
function reportSaveFailure(
  error: unknown,
  retry: () => Promise<void>,
  options: Pick<SettingsRuntime, "onError" | "persistedRef" | "setSettings"> &
    Readonly<{ setSaveMessage: Dispatch<SetStateAction<string>> }>,
): void {
  options.setSettings({ ...options.persistedRef.current });
  options.setSaveMessage("");
  options.onError(getErrorMessage(error, "Не удалось сохранить настройки."), retry);
}
async function persistSettings({
  previous,
  requested,
  revision,
  persistedRef,
  revisionRef,
  setSettings,
  setSaveMessage,
  onError,
  retry,
}: SettingsRuntime &
  Readonly<{
    previous: Readonly<Promise<void>>;
    requested: Readonly<Partial<Settings>>;
    revision: number;
    setSaveMessage: Dispatch<SetStateAction<string>>;
    retry: () => Promise<void>;
  }>): Promise<void> {
  await previous;
  try {
    const saved = normalizeSettings(
      await invoke<Settings>("update_settings", {
        // Merge inside the queue so delayed saves cannot overwrite newer fields.
        settings: { ...persistedRef.current, ...requested },
      }),
    );
    persistedRef.current = saved;

    if (revision === revisionRef.current) {
      setSettings(saved);
      setSaveMessage("Настройки сохранены");
    }
  } catch (error) {
    if (revision === revisionRef.current) {
      reportSaveFailure(error, retry, { onError, persistedRef, setSaveMessage, setSettings });
    }
    throw error;
  }
}

async function saveSettingsOperation(
  patch: Readonly<Partial<Settings>>,
  {
    onClearError,
    onError,
    persistedRef,
    queueRef,
    revisionRef,
    setSaveMessage,
    setSettings,
  }: SettingsRuntime &
    Readonly<{ onClearError: () => void; setSaveMessage: Dispatch<SetStateAction<string>> }>,
): Promise<void> {
  const requested = { ...patch };
  revisionRef.current += REVISION_STEP;
  const revision = revisionRef.current;
  setSettings((current) => ({ ...current, ...requested }));
  setSaveMessage("Сохраняю настройки…");
  onClearError();

  const previous = queueRef.current;
  const operation = persistSettings({
    onError,
    persistedRef,
    previous,
    queueRef,
    requested,
    retry: async (): Promise<void> => {
      await saveSettingsOperation(requested, {
        onClearError,
        onError,
        persistedRef,
        queueRef,
        revisionRef,
        setSaveMessage,
        setSettings,
      });
    },
    revision,
    revisionRef,
    setSaveMessage,
    setSettings,
  });

  queueRef.current = (async (): Promise<void> => {
    try {
      await operation;
    } catch {
      // Each save reports its own error; keep the queue usable.
    }
  })();
  await operation;
}

function useSettingsSave({
  onClearError,
  onError,
  persistedRef,
  queueRef,
  revisionRef,
  setSaveMessage,
  setSettings,
}: SettingsRuntime &
  Readonly<{
    onClearError: () => void;
    setSaveMessage: Dispatch<SetStateAction<string>>;
  }>): SettingsData["saveSettings"] {
  const saveSettings = useCallback(
    async (patch: Readonly<Partial<Settings>>): Promise<void> => {
      await saveSettingsOperation(patch, {
        onClearError,
        onError,
        persistedRef,
        queueRef,
        revisionRef,
        setSaveMessage,
        setSettings,
      });
    },
    [onError, onClearError, persistedRef, queueRef, revisionRef, setSaveMessage, setSettings],
  );

  return saveSettings;
}
async function loadPersistedSettings(queue: Readonly<Promise<void>>): Promise<Settings> {
  await queue;
  return normalizeSettings(await invoke<Settings>("get_settings"));
}
async function loadSettingsOperation({
  loadRevisionRef,
  onError,
  persistedRef,
  queueRef,
  revisionRef,
  setIsLoaded,
  setSettings,
}: SettingsRuntime &
  Readonly<{
    loadRevisionRef: RefObject<number>;
    setIsLoaded: Dispatch<SetStateAction<boolean>>;
  }>): Promise<void> {
  const snapshot = {
    loadRevision: loadRevisionRef.current + REVISION_STEP,
    revision: revisionRef.current,
  };
  loadRevisionRef.current = snapshot.loadRevision;
  try {
    const loaded = await loadPersistedSettings(queueRef.current);
    if (
      snapshot.revision !== revisionRef.current ||
      snapshot.loadRevision !== loadRevisionRef.current
    ) {
      return;
    }
    setSettings(loaded);
    persistedRef.current = { ...loaded };
    setIsLoaded(true);
  } catch (error) {
    onError(getErrorMessage(error, "Не удалось загрузить настройки."), async (): Promise<void> => {
      await loadSettingsOperation({
        loadRevisionRef,
        onError,
        persistedRef,
        queueRef,
        revisionRef,
        setIsLoaded,
        setSettings,
      });
    });
  }
}

function useSettingsLoad({
  loadRevisionRef,
  onError,
  persistedRef,
  queueRef,
  revisionRef,
  setIsLoaded,
  setSettings,
}: SettingsRuntime &
  Readonly<{
    loadRevisionRef: RefObject<number>;
    setIsLoaded: Dispatch<SetStateAction<boolean>>;
  }>): () => Promise<void> {
  const loadSettings = useCallback(async (): Promise<void> => {
    await loadSettingsOperation({
      loadRevisionRef,
      onError,
      persistedRef,
      queueRef,
      revisionRef,
      setIsLoaded,
      setSettings,
    });
  }, [onError, loadRevisionRef, persistedRef, queueRef, revisionRef, setIsLoaded, setSettings]);

  return loadSettings;
}

function useSettingsData({ onError, onClearError }: Readonly<UseSettingsOptions>): SettingsData {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [isLoaded, setIsLoaded] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  const persistedRef = useRef<Settings>({ ...DEFAULT_SETTINGS });
  const revisionRef = useRef(INITIAL_REVISION);
  const loadRevisionRef = useRef(INITIAL_REVISION);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const saveSettings = useSettingsSave({
    onClearError,
    onError,
    persistedRef,
    queueRef,
    revisionRef,
    setSaveMessage,
    setSettings,
  });
  const loadSettings = useSettingsLoad({
    loadRevisionRef,
    onError,
    persistedRef,
    queueRef,
    revisionRef,
    setIsLoaded,
    setSettings,
  });

  return { isLoaded, loadSettings, saveMessage, saveSettings, setSettings, settings };
}

function useSettingsEvents(
  loadSettings: () => Promise<void>,
  onError: UseSettingsOptions["onError"],
): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    async function subscribe(): Promise<void> {
      try {
        const dispose = await listen("slovo://settings-changed", (): void => {
          if (!cancelled) {
            void loadSettings();
          }
        });
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
      } catch {
        if (!cancelled) {
          onError("Не удалось подключить обновление настроек.");
        }
      }
    }
    void subscribe();
    return (): void => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadSettings, onError]);
}

function useSettingEdits(
  saveSettings: SettingsData["saveSettings"],
): Pick<SettingsResult, "saveServerNow" | "scheduleServerSave" | "updateSetting"> {
  const serverTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const saveServerNow = useCallback(
    (value: string): void => {
      if (serverTimerRef.current !== null) {
        globalThis.clearTimeout(serverTimerRef.current);
      }
      serverTimerRef.current = null;
      const serverUrl = validServerUrl(value);
      if (serverUrl !== null) {
        void acceptReportedFailure(saveSettings({ serverUrl }));
      }
    },
    [saveSettings],
  );

  const scheduleServerSave = useCallback(
    (value: string): void => {
      if (serverTimerRef.current !== null) {
        globalThis.clearTimeout(serverTimerRef.current);
      }
      serverTimerRef.current = globalThis.setTimeout((): void => {
        saveServerNow(value);
      }, SAVE_DELAY_MS);
    },
    [saveServerNow],
  );

  const updateSetting = useCallback(
    <Key extends keyof Settings>(key: Key, value: Settings[Key]) => {
      const next = { [key]: value };
      void acceptReportedFailure(saveSettings(next));
    },
    [saveSettings],
  );

  return { saveServerNow, scheduleServerSave, updateSetting };
}

function useSettings(options: Readonly<UseSettingsOptions>): SettingsResult {
  const data = useSettingsData(options);
  useSettingsEvents(data.loadSettings, options.onError);
  const edits = useSettingEdits(data.saveSettings);
  return { ...data, ...edits };
}

export { useSettings };
