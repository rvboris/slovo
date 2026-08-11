import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatHotkey, isModifierKey } from "@/lib/hotkey";
import { getErrorMessage } from "@/lib/types";

let captureToken = Date.now() * 1000;

function nextCaptureToken() {
  captureToken += 1;
  return captureToken;
}

interface UseHotkeyOptions {
  hotkey: string;
  enabled: boolean;
  onSave: (hotkey: string) => void;
  onError: (message: string) => void;
}

export function useHotkey({ hotkey, enabled, onSave, onError }: UseHotkeyOptions) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [isStartingCapture, setIsStartingCapture] = useState(false);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const captureTokenRef = useRef(0);
  const mountedRef = useRef(true);

  const setBackendCapture = useCallback((active: boolean, token: number) => {
    return invoke<void>("set_hotkey_capture_active", { active, token });
  }, []);

  const endCapture = useCallback(() => {
    const token = nextCaptureToken();
    captureTokenRef.current = token;
    setIsCapturing(false);
    setIsStartingCapture(false);
    setCaptureMessage(null);
    void setBackendCapture(false, token).catch((error) => {
      if (mountedRef.current) {
        onError(getErrorMessage(error, "Не удалось завершить захват сочетания."));
      }
    });
  }, [onError, setBackendCapture]);

  const beginCapture = useCallback(async () => {
    if (!enabled || isCapturing || isStartingCapture) return;

    const token = nextCaptureToken();
    captureTokenRef.current = token;
    setIsStartingCapture(true);
    try {
      await setBackendCapture(true, token);
      if (!mountedRef.current || token !== captureTokenRef.current) {
        void setBackendCapture(false, token).catch(() => undefined);
        return;
      }
      setIsCapturing(true);
      setCaptureMessage("Нажмите сочетание…");
    } catch (error) {
      // Also send the compensating command: invoke may reject after the backend
      // has already applied the state.
      void setBackendCapture(false, token).catch(() => undefined);
      if (mountedRef.current && token === captureTokenRef.current) {
        onError(getErrorMessage(error, "Не удалось начать изменение хоткея."));
      }
    } finally {
      if (mountedRef.current && token === captureTokenRef.current) {
        setIsStartingCapture(false);
      }
    }
  }, [enabled, isCapturing, isStartingCapture, onError, setBackendCapture]);

  useEffect(() => {
    mountedRef.current = true;
    // Tauri keeps the Rust state across frontend HMR. Clear a capture latch
    // left behind if the previous webview was reloaded before its cleanup ran.
    const token = nextCaptureToken();
    captureTokenRef.current = token;
    void setBackendCapture(false, token).catch(() => undefined);

    return () => {
      mountedRef.current = false;
      const token = nextCaptureToken();
      captureTokenRef.current = token;
      void setBackendCapture(false, token).catch(() => undefined);
    };
  }, [setBackendCapture]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        endCapture();
        return;
      }

      const result = formatHotkey(event);
      if (!result) {
        setCaptureMessage(
          isModifierKey(event.key)
            ? "Добавьте клавишу…"
            : "Нужно поддерживаемое сочетание",
        );
        return;
      }

      onSave(result);
      endCapture();
    },
    [endCapture, onSave],
  );

  useEffect(() => {
    if (!isCapturing) return;
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isCapturing, handleKeyDown]);

  const handleClick = useCallback(() => {
    if (isCapturing) {
      endCapture();
    } else {
      void beginCapture();
    }
  }, [isCapturing, beginCapture, endCapture]);

  return {
    isCapturing,
    isStartingCapture,
    captureMessage,
    displayHotkey: hotkey,
    handleClick,
  };
}
