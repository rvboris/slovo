import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Commands } from "@/lib/ipc";
import {
  DEFAULT_SETTINGS,
  getErrorMessage,
  normalizeSettings,
  type SaveKind,
  type Settings,
} from "@/lib/types";
import { normalizeHttpUrl } from "@/lib/url";

interface UseSettingsOptions {
  onError: (message: string, retry?: () => Promise<void>) => void;
  onClearError: () => void;
}

export function useSettings({ onError, onClearError }: UseSettingsOptions) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [isLoaded, setIsLoaded] = useState(false);
  const [saveState, setSaveState] = useState<{ text: string; kind: SaveKind }>({
    text: "",
    kind: "idle",
  });

  const persistedRef = useRef<Settings>({ ...DEFAULT_SETTINGS });
  const revisionRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const serverTimerRef = useRef<number | undefined>(undefined);
  const savedIndicatorTimerRef = useRef<number | undefined>(undefined);

  // A pending "saved" indicator timeout must never fire after unmount.
  useEffect(() => {
    return () => {
      if (savedIndicatorTimerRef.current !== undefined) {
        window.clearTimeout(savedIndicatorTimerRef.current);
      }
    };
  }, []);

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
            await invoke<Settings>(Commands.updateSettings, {
              settings: requested,
            }),
          );
          persistedRef.current = saved;

          if (revision === revisionRef.current) {
            setSettings(saved);
            setSaveStateHelper("Изменения сохранены", "saved");
            if (savedIndicatorTimerRef.current !== undefined) {
              window.clearTimeout(savedIndicatorTimerRef.current);
            }
            savedIndicatorTimerRef.current = window.setTimeout(() => {
              // The revision guard alone decides staleness: a newer save (or
              // an error path) bumps the revision before this fires.
              if (revision === revisionRef.current) {
                setSaveStateHelper("");
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
    [onError, onClearError, setSaveStateHelper],
  );

  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const loaded = normalizeSettings(
        await invoke<Settings>(Commands.getSettings),
      );
      setSettings(loaded);
      persistedRef.current = { ...loaded };
      setIsLoaded(true);
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
        const normalized = normalizeHttpUrl(value);
        if (!normalized) return;
        void saveSettings({ ...settings, serverUrl: normalized }).catch(
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
      const normalized = normalizeHttpUrl(value);
      if (!normalized || normalized === settings.serverUrl) return;
      void saveSettings({ ...settings, serverUrl: normalized }).catch(
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
    isLoaded,
    saveState,
    loadSettings,
    saveSettings,
    scheduleServerSave,
    saveServerNow,
    updateSetting,
  };
}
