import type { StatusKind, StatusPayload } from "@/lib/types";
import { useCallback, useEffect, useState } from "react";
import { formatElapsed } from "@/lib/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface StatusState {
  readonly kind: StatusKind;
  readonly text: string;
}
const statusLabels: Readonly<Record<StatusKind, string>> = {
  copied: "Скопировано — вставьте вручную",
  correcting: "Корректирую…",
  error: "Ошибка — подробности в главном окне",
  inserted: "Текст вставлен",
  ready: "Готово",
  recording: "Слушаю",
  transcribing: "Распознаю…",
};
function statusText(payload: Readonly<StatusPayload>): string {
  if (payload.kind === "recording") {
    return `Слушаю · ${formatElapsed(payload.elapsedSeconds)}`;
  }
  const label = statusLabels[payload.kind];
  if (
    (payload.kind === "inserted" || payload.kind === "copied") &&
    (payload.correctionWarning ?? "") !== ""
  ) {
    return `${label} · Без корректировки`;
  }
  return label;
}
function useStatusEvents(
  setStatus: (payload: Readonly<StatusPayload>) => void,
  onError: (message: string) => void,
): void {
  useEffect(() => {
    const lifecycle = {
      cancelled: false,
      revision: -1,
      unlisten: (): void => {
        // Not registered yet.
      },
    };
    const apply = (payload: Readonly<StatusPayload>): void => {
      if (lifecycle.cancelled || payload.revision <= lifecycle.revision) {
        return;
      }
      lifecycle.revision = payload.revision;
      setStatus(payload);
    };
    async function subscribe(): Promise<void> {
      try {
        const dispose = await listen<StatusPayload>("slovo://status", ({ payload }) => {
          apply(payload);
        });
        if (lifecycle.cancelled) {
          dispose();
          return;
        }
        lifecycle.unlisten = dispose;
        apply(await invoke<StatusPayload>("get_status"));
      } catch {
        if (!lifecycle.cancelled) {
          onError("Не удалось синхронизировать состояние.");
        }
      }
    }
    void subscribe();
    return (): void => {
      lifecycle.cancelled = true;
      lifecycle.unlisten();
    };
  }, [setStatus, onError]);
}
function useStatus(
  onConnectionError: (message: string, retry?: () => Promise<void>) => void,
): StatusState & {
  dismissWarning: () => void;
  warning: string;
  operationalError: string;
  dismissOperationalError: () => void;
} {
  const [statusState, setStatusState] = useState<StatusState>({ kind: "ready", text: "Готово" });
  const [warning, setWarning] = useState("");
  const [operationalError, setOperationalError] = useState("");
  const apply = useCallback((payload: Readonly<StatusPayload>): void => {
    setStatusState({ kind: payload.kind, text: statusText(payload) });
    if ((payload.correctionWarning ?? "") !== "") {
      setWarning(`Предыдущая операция · Без корректировки: ${payload.correctionWarning}`);
    }
    if (payload.kind === "error") {
      setOperationalError(
        `Ошибка предыдущей операции: ${payload.message ?? "Подробности недоступны."}`,
      );
    }
  }, []);
  useStatusEvents(apply, onConnectionError);
  const dismissWarning = useCallback((): void => {
    setWarning("");
  }, []);
  const dismissOperationalError = useCallback((): void => {
    setOperationalError("");
  }, []);
  return { ...statusState, dismissOperationalError, dismissWarning, operationalError, warning };
}
export { useStatus };
