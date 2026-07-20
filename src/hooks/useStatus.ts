import { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  type StatusKind,
  type StatusPayload,
  formatElapsed,
} from "@/lib/types";

interface StatusState {
  kind: StatusKind;
  text: string;
}

const statusLabels: Record<StatusKind, string> = {
  ready: "Готово",
  recording: "Слушаю",
  transcribing: "Распознаю…",
  inserted: "Текст вставлен",
  copied: "Скопировано",
  error: "Ошибка",
};

export function useStatus(
  onError: (message: string, retry?: () => Promise<void>) => void,
  onClearError: () => void,
) {
  const [status, setStatusState] = useState<StatusState>({
    kind: "ready",
    text: "Готово",
  });
  const timerRef = useRef<number | undefined>(undefined);

  const setStatus = useCallback(
    (payload: StatusPayload) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);

      const text =
        payload.message ||
        (payload.kind === "recording"
          ? `Слушаю · ${formatElapsed(payload.elapsedSeconds)}`
          : statusLabels[payload.kind]);

      setStatusState({ kind: payload.kind, text });

      if (payload.kind === "error") {
        onError(payload.message || "Не удалось выполнить действие.");
      } else {
        onClearError();
      }

      if (payload.kind === "inserted" || payload.kind === "copied") {
        timerRef.current = window.setTimeout(
          () => setStatus({ kind: "ready" }),
          2400,
        );
      }
    },
    [onError, onClearError],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<StatusPayload>("slovo://status", ({ payload }) => {
      if (!cancelled) setStatus(payload);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        onError("Не удалось подключить отображение состояния.");
      });

    return () => {
      cancelled = true;
      unlisten?.();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [setStatus, onError]);

  return status;
}
