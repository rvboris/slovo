import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ShortcutBackendStatusPayload, ShortcutViewState } from "@/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage } from "@/lib/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const INITIAL_REVISION = 0;

interface ShortcutStatus {
  readonly view: ShortcutViewState;
  readonly text: string;
  readonly canRetry: boolean;
  readonly canSetup: boolean;
  readonly isBusy: boolean;
}

interface UseShortcutStatusOptions {
  readonly onError: (message: string, retry?: () => Promise<void>) => void;
  readonly onClearError: () => void;
  readonly onPermissionDenied: (canSetup: boolean) => void;
}

async function loadShortcutOperation({
  eventRevisionRef,
  renderStatus,
  onError,
}: Readonly<{
  eventRevisionRef: RefObject<number>;
  renderStatus: (payload: Readonly<ShortcutBackendStatusPayload>) => void;
  onError: (message: string, retry?: () => Promise<void>) => void;
}>): Promise<void> {
  // A shortcut-status event received while this request is in flight is
  // Newer than the response, so the response must not overwrite it.
  const requestRevision = eventRevisionRef.current;
  try {
    const result = await invoke<ShortcutBackendStatusPayload>("get_shortcut_backend_status");
    if (eventRevisionRef.current === requestRevision) {
      renderStatus(result);
    }
  } catch (error) {
    if (eventRevisionRef.current === requestRevision) {
      renderStatus({ detail: "", state: "failed" });
    }
    onError(
      getErrorMessage(error, "Не удалось получить состояние сочетания."),
      async (): Promise<void> => {
        await loadShortcutOperation({ eventRevisionRef, onError, renderStatus });
      },
    );
  }
}

function useLoadShortcutStatus({
  eventRevisionRef,
  renderStatus,
  onError,
}: Readonly<{
  eventRevisionRef: RefObject<number>;
  renderStatus: (payload: Readonly<ShortcutBackendStatusPayload>) => void;
  onError: (message: string, retry?: () => Promise<void>) => void;
}>): () => Promise<void> {
  const loadShortcutStatus = useCallback(async (): Promise<void> => {
    await loadShortcutOperation({ eventRevisionRef, onError, renderStatus });
  }, [renderStatus, onError, eventRevisionRef]);
  return loadShortcutStatus;
}
function permissionText(canSetup: boolean): string {
  if (canSetup) {
    return "Нет доступа к клавиатуре. В Wayland для глобального сочетания нужно разрешить чтение устройств ввода — тогда Слово видит только нажатия назначенного сочетания. Откройте «Настроить доступ», чтобы разрешить, или повторите попытку.";
  }
  return "Нет доступа к клавиатуре. В Wayland для глобального сочетания нужно разрешить чтение устройств ввода. Повторите попытку.";
}
function failureText(detail: string | undefined): string {
  const text = detail?.trim() ?? "";
  if (text === "") {
    return "Не удалось запустить сочетание. Повторите попытку.";
  }
  return `Не удалось запустить сочетание: ${text}`;
}
function mapPayloadToStatus(
  payload: Readonly<ShortcutBackendStatusPayload>,
): Omit<ShortcutStatus, "isBusy"> {
  const base = { canRetry: false, canSetup: false };
  switch (payload.state) {
    case "starting":
    case "restarting": {
      return { ...base, text: "Готовим глобальное сочетание…", view: "preparing" };
    }
    case "active": {
      return { ...base, text: "Сочетание активно", view: "active" };
    }
    case "permission-denied": {
      return {
        canRetry: true,
        canSetup: payload.setupAvailable === true,
        text: permissionText(payload.setupAvailable === true),
        view: "warning",
      };
    }
    case "devices-unavailable": {
      return {
        ...base,
        canRetry: true,
        text: "Не нашли подходящих устройств ввода. Проверьте, что клавиатура подключена и доступна для чтения, и повторите попытку.",
        view: "warning",
      };
    }
    case "failed": {
      return { ...base, canRetry: true, text: failureText(payload.detail), view: "error" };
    }
    case "shutting-down": {
      return { ...base, text: "Завершаем работу…", view: "neutral" };
    }
    default: {
      return { ...base, text: "Состояние сочетания неизвестно", view: "neutral" };
    }
  }
}

function useShortcutEvents(
  renderStatus: (payload: Readonly<ShortcutBackendStatusPayload>) => void,
  onError: UseShortcutStatusOptions["onError"],
  eventRevisionRef: RefObject<number>,
): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    async function subscribe(): Promise<void> {
      try {
        const dispose = await listen<ShortcutBackendStatusPayload>(
          "slovo://shortcut-status",
          ({ payload }) => {
            if (!cancelled) {
              eventRevisionRef.current += 1;
              renderStatus(payload);
            }
          },
        );
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
      } catch {
        if (!cancelled) {
          onError("Не удалось подключить отображение состояния сочетания.");
        }
      }
    }
    void subscribe();

    return (): void => {
      cancelled = true;
      unlisten?.();
    };
  }, [renderStatus, onError, eventRevisionRef]);
}

async function retryShortcutOperation({
  onClearError,
  onError,
  renderStatus,
  retryPendingRef,
  setStatus,
}: Readonly<{
  onClearError: () => void;
  onError: UseShortcutStatusOptions["onError"];
  renderStatus: (payload: Readonly<ShortcutBackendStatusPayload>) => void;
  retryPendingRef: RefObject<boolean>;
  setStatus: Dispatch<SetStateAction<ShortcutStatus>>;
}>): Promise<void> {
  if (retryPendingRef.current) {
    return;
  }
  retryPendingRef.current = true;
  setStatus((prev) => ({ ...prev, isBusy: true }));
  try {
    renderStatus(await invoke<ShortcutBackendStatusPayload>("retry_shortcut_backend"));
    onClearError();
  } catch (error) {
    onError(
      getErrorMessage(error, "Не удалось перезапустить сочетание."),
      async (): Promise<void> => {
        await retryShortcutOperation({
          onClearError,
          onError,
          renderStatus,
          retryPendingRef,
          setStatus,
        });
      },
    );
  } finally {
    retryPendingRef.current = false;
    setStatus((prev) => ({ ...prev, isBusy: false }));
  }
}

function useShortcutRetry({
  onClearError,
  onError,
  renderStatus,
  retryPendingRef,
  setStatus,
}: Readonly<{
  onClearError: () => void;
  onError: UseShortcutStatusOptions["onError"];
  renderStatus: (payload: Readonly<ShortcutBackendStatusPayload>) => void;
  retryPendingRef: RefObject<boolean>;
  setStatus: Dispatch<SetStateAction<ShortcutStatus>>;
}>): () => Promise<void> {
  const retryShortcutBackend = useCallback(async (): Promise<void> => {
    await retryShortcutOperation({
      onClearError,
      onError,
      renderStatus,
      retryPendingRef,
      setStatus,
    });
  }, [renderStatus, onError, onClearError, retryPendingRef, setStatus]);

  return retryShortcutBackend;
}

export function useShortcutStatus({
  onError,
  onClearError,
  onPermissionDenied,
}: Readonly<UseShortcutStatusOptions>): {
  loadShortcutStatus: () => Promise<void>;
  retryShortcutBackend: () => Promise<void>;
  status: ShortcutStatus;
} {
  const [status, setStatus] = useState<ShortcutStatus>({
    canRetry: false,
    canSetup: false,
    isBusy: false,
    text: "Готовим глобальное сочетание…",
    view: "idle",
  });
  const retryPendingRef = useRef(false);
  const eventRevisionRef = useRef(INITIAL_REVISION);

  const renderStatus = useCallback(
    (payload: Readonly<ShortcutBackendStatusPayload>) => {
      const mapped = mapPayloadToStatus(payload);
      setStatus((prev) => ({ ...prev, ...mapped }));
      onPermissionDenied(mapped.canSetup);
    },
    [onPermissionDenied],
  );

  const retryShortcutBackend = useShortcutRetry({
    onClearError,
    onError,
    renderStatus,
    retryPendingRef,
    setStatus,
  });

  const loadShortcutStatus = useLoadShortcutStatus({ eventRevisionRef, onError, renderStatus });

  useShortcutEvents(renderStatus, onError, eventRevisionRef);

  return {
    loadShortcutStatus,
    retryShortcutBackend,
    status,
  };
}
