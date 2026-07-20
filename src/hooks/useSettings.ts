import { useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  type Settings,
  type SaveKind,
  DEFAULT_SETTINGS,
  normalizeSettings,
  getErrorMessage,
} from "@/lib/types";

interface UseSettingsOptions {
  onError: (message: string, retry?: () => Promise<void>) => void;
  onClearError: () => void;
}

export function useSettings({ onError, onClearError }: UseSettingsOptions) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [saveState, setSaveState] = useState<{ text: string; kind: SaveKind }>({
    text: "Изменения сохраняются автоматически",
    kind: "idle",
  });

  const persistedRef = useRef<Settings>({ ...DEFAULT_SETTINGS });
  const revisionRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const serverTimerRef = useRef<number | undefined>(undefined);

  const setSaveStateHelper = useCallback(
    (text: string, kind: SaveKind = "idle") => {
      setSaveState({ text, kind });
    },
    [],
  );

  const saveSettings = useCallback(
    (nextSettings: Settings): Promise<void> => {
      const requested = { ...nextSettings };
      const revision = ++revisionRef.current;
      setSettings(requested);
      setSaveStateHelper("Сохраняю…", "saving");
      onClearError();

      const operation = queueRef.current.then(async () => {
        try {
          const saved = normalizeSettings(
            await invoke<Settings>("update_settings", {
              settings: requested,
            }),
          );
          persistedRef.current = saved;

          if (revision === revisionRef.current) {
            setSettings(saved);
            setSaveStateHelper("Изменения сохранены", "saved");
            window.setTimeout(() => {
              if (
                revision === revisionRef.current &&
                saveState.text === "Изменения сохранены"
              ) {
                setSaveStateHelper("Изменения сохраняются автоматически");
              }
            }, 1800);
          }
        } catch (error) {
          if (revision === revisionRef.current) {
            setSettings({ ...persistedRef.current });
            setSaveStateHelper("Не удалось сохранить", "error");
            onError(
              getErrorMessage(error, "Не удалось сохранить настройки."),
              () => saveSettings(requested),
            );
          }
          throw error;
        }
      });

      queueRef.current = operation.catch(() => undefined);
      return operation;
    },
    [onError, onClearError, setSaveStateHelper, saveState.text],
  );

  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const loaded = normalizeSettings(
        await invoke<Settings>("get_settings"),
      );
      setSettings(loaded);
      persistedRef.current = { ...loaded };
    } catch (error) {
      onError(
        getErrorMessage(error, "Не удалось загрузить настройки."),
        loadSettings,
      );
    }
  }, [onError]);

  const scheduleServerSave = useCallback(
    (value: string) => {
      if (serverTimerRef.current) window.clearTimeout(serverTimerRef.current);

      serverTimerRef.current = window.setTimeout(() => {
        serverTimerRef.current = undefined;
        const trimmed = value.trim();
        if (!trimmed) return;
        try {
          const url = new URL(trimmed);
          if (url.protocol !== "http:" && url.protocol !== "https:") return;
        } catch {
          return;
        }
        void saveSettings({ ...settings, serverUrl: trimmed }).catch(
          () => undefined,
        );
      }, 400);
    },
    [saveSettings, settings],
  );

  const saveServerNow = useCallback(
    (value: string) => {
      if (serverTimerRef.current) window.clearTimeout(serverTimerRef.current);
      serverTimerRef.current = undefined;
      const trimmed = value.trim();
      if (!trimmed || trimmed === settings.serverUrl) return;
      try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
      } catch {
        return;
      }
      void saveSettings({ ...settings, serverUrl: trimmed }).catch(
        () => undefined,
      );
    },
    [saveSettings, settings],
  );

  const updateSetting = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) => {
      const next = { ...settings, [key]: value };
      void saveSettings(next).catch(() => undefined);
    },
    [saveSettings, settings],
  );

  return {
    settings,
    saveState,
    loadSettings,
    saveSettings,
    scheduleServerSave,
    saveServerNow,
    updateSetting,
    setSettings,
  };
}
