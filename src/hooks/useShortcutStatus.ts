import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type ShortcutBackendStatusPayload,
  type ShortcutViewState,
  getErrorMessage,
} from "@/lib/types";

interface ShortcutStatus {
  view: ShortcutViewState;
  text: string;
  canRetry: boolean;
  canSetup: boolean;
  isBusy: boolean;
}

interface UseShortcutStatusOptions {
  onError: (message: string, retry?: () => Promise<void>) => void;
  onClearError: () => void;
  onPermissionDenied: (canSetup: boolean) => void;
}

function shortcutDeviceLabel(count?: number): string {
  if (!count || count <= 0) return "";
  const lastTwo = count % 100;
  const last = count % 10;
  const word =
    lastTwo >= 11 && lastTwo <= 14
      ? "устройств"
      : last === 1
        ? "устройство"
        : last >= 2 && last <= 4
          ? "устройства"
          : "устройств";
  return ` · ${count} ${word}`;
}

function mapPayloadToStatus(
  payload: ShortcutBackendStatusPayload,
): Omit<ShortcutStatus, "isBusy"> {
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

  return { view, text, canRetry, canSetup };
}

export function useShortcutStatus({
  onError,
  onClearError,
  onPermissionDenied,
}: UseShortcutStatusOptions) {
  const [status, setStatus] = useState<ShortcutStatus>({
    view: "idle",
    text: "Готовим глобальное сочетание…",
    canRetry: false,
    canSetup: false,
    isBusy: false,
  });
  const retryPendingRef = useRef(false);

  const renderStatus = useCallback(
    (payload: ShortcutBackendStatusPayload) => {
      const mapped = mapPayloadToStatus(payload);
      setStatus((prev) => ({ ...prev, ...mapped }));
      onPermissionDenied(mapped.canSetup);
    },
    [onPermissionDenied],
  );

  const retryShortcutBackend = useCallback(async (): Promise<void> => {
    if (retryPendingRef.current) return;
    retryPendingRef.current = true;
    setStatus((prev) => ({ ...prev, isBusy: true }));
    try {
      const result = await invoke<ShortcutBackendStatusPayload>(
        "retry_shortcut_backend",
      );
      renderStatus(result);
      onClearError();
    } catch (error) {
      onError(
        getErrorMessage(error, "Не удалось перезапустить сочетание."),
        retryShortcutBackend,
      );
    } finally {
      retryPendingRef.current = false;
      setStatus((prev) => ({ ...prev, isBusy: false }));
    }
  }, [renderStatus, onError, onClearError]);

  const loadShortcutStatus = useCallback(async (): Promise<void> => {
    try {
      const result = await invoke<ShortcutBackendStatusPayload>(
        "get_shortcut_backend_status",
      );
      renderStatus(result);
    } catch (error) {
      renderStatus({ state: "failed", detail: "" });
      onError(
        getErrorMessage(error, "Не удалось получить состояние сочетания."),
        loadShortcutStatus,
      );
    }
  }, [renderStatus, onError]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<ShortcutBackendStatusPayload>(
      "slovo://shortcut-status",
      ({ payload }) => {
        if (!cancelled) renderStatus(payload);
      },
    )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        onError(
          "Не удалось подключить отображение состояния сочетания.",
        );
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [renderStatus, onError]);

  return {
    status,
    retryShortcutBackend,
    loadShortcutStatus,
  };
}
