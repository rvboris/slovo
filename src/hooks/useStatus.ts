import { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { Events } from "@/lib/ipc";
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
  onConnectionError: (message: string, retry?: () => Promise<void>) => void,
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
        timerRef.current = window.setTimeout(
          () => setStatus({ kind: "ready" }),
          2000,
        );
      } else if (payload.kind === "inserted" || payload.kind === "copied") {
        timerRef.current = window.setTimeout(
          () => setStatus({ kind: "ready" }),
          2400,
        );
      }
    },
    [],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<StatusPayload>(Events.status, ({ payload }) => {
      if (!cancelled) setStatus(payload);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        onConnectionError("Не удалось подключить отображение состояния.");
      });

    return () => {
      cancelled = true;
      unlisten?.();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [setStatus, onConnectionError]);

  return status;
}
