import type { Dispatch, RefObject, SetStateAction } from "react";
import { formatHotkey, isModifierKey } from "@/lib/hotkey";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getErrorMessage } from "@/lib/types";
import { invoke } from "@tauri-apps/api/core";

const TOKEN_SCALE = 1000;
const TOKEN_STEP = 1;
const INITIAL_TOKEN = 0;
let captureToken = Date.now() * TOKEN_SCALE;

function nextCaptureToken(): number {
  captureToken += TOKEN_STEP;
  return captureToken;
}

async function setBackendCapture(active: boolean, token: number): Promise<void> {
  await invoke("set_hotkey_capture_active", { active, token });
}
function useEndCapture({
  captureTokenRef,
  setIsCapturing,
  setIsStartingCapture,
  setCaptureMessage,
  mountedRef,
  onError,
}: Readonly<{
  captureTokenRef: RefObject<number>;
  setIsCapturing: Dispatch<SetStateAction<boolean>>;
  setIsStartingCapture: Dispatch<SetStateAction<boolean>>;
  setCaptureMessage: Dispatch<SetStateAction<string | null>>;
  mountedRef: RefObject<boolean>;
  onError: (message: string) => void;
}>): () => void {
  const endCapture = useCallback((): void => {
    const token = nextCaptureToken();
    captureTokenRef.current = token;
    setIsCapturing(false);
    setIsStartingCapture(false);
    setCaptureMessage(null);
    async function release(): Promise<void> {
      try {
        await setBackendCapture(false, token);
      } catch (error) {
        if (mountedRef.current) {
          onError(getErrorMessage(error, "Не удалось завершить захват сочетания."));
        }
      }
    }
    void release();
  }, [
    onError,
    captureTokenRef,
    setIsCapturing,
    setIsStartingCapture,
    setCaptureMessage,
    mountedRef,
  ]);
  return endCapture;
}

async function releaseCapture(token: number): Promise<void> {
  try {
    await setBackendCapture(false, token);
  } catch {
    // Best-effort release; a newer capture token remains authoritative.
  }
}

function reportCaptureError(
  error: unknown,
  token: number,
  options: Readonly<{
    captureTokenRef: Readonly<RefObject<number>>;
    mountedRef: Readonly<RefObject<boolean>>;
    onError: (message: string) => void;
  }>,
): void {
  void releaseCapture(token);
  if (options.mountedRef.current && token === options.captureTokenRef.current) {
    options.onError(getErrorMessage(error, "Не удалось начать изменение хоткея."));
  }
}
async function startCapture(
  token: number,
  options: Readonly<{
    captureTokenRef: RefObject<number>;
    mountedRef: RefObject<boolean>;
    setIsCapturing: Dispatch<SetStateAction<boolean>>;
    setCaptureMessage: Dispatch<SetStateAction<string | null>>;
    setIsStartingCapture: Dispatch<SetStateAction<boolean>>;
    onError: (message: string) => void;
  }>,
): Promise<void> {
  const { captureTokenRef, mountedRef, setIsCapturing, setCaptureMessage, setIsStartingCapture } =
    options;
  try {
    await setBackendCapture(true, token);
    if (mountedRef.current && token === captureTokenRef.current) {
      setIsCapturing(true);
      setCaptureMessage("Нажмите сочетание…");
    } else {
      void releaseCapture(token);
    }
  } catch (error) {
    // Also send the compensating command: invoke may reject after the backend
    // Has already applied the state.
    reportCaptureError(error, token, options);
  } finally {
    if (mountedRef.current && token === captureTokenRef.current) {
      setIsStartingCapture(false);
    }
  }
}

function useBeginCapture({
  enabled,
  isCapturing,
  isStartingCapture,
  captureTokenRef,
  setIsStartingCapture,
  mountedRef,
  setIsCapturing,
  setCaptureMessage,
  onError,
}: Readonly<{
  enabled: boolean;
  isCapturing: boolean;
  isStartingCapture: boolean;
  captureTokenRef: RefObject<number>;
  setIsStartingCapture: Dispatch<SetStateAction<boolean>>;
  mountedRef: RefObject<boolean>;
  setIsCapturing: Dispatch<SetStateAction<boolean>>;
  setCaptureMessage: Dispatch<SetStateAction<string | null>>;
  onError: (message: string) => void;
}>): () => Promise<void> {
  const beginCapture = useCallback(async (): Promise<void> => {
    if (!enabled || isCapturing || isStartingCapture) {
      return;
    }

    const token = nextCaptureToken();
    captureTokenRef.current = token;
    setIsStartingCapture(true);
    await startCapture(token, {
      captureTokenRef,
      mountedRef,
      onError,
      setCaptureMessage,
      setIsCapturing,
      setIsStartingCapture,
    });
  }, [
    enabled,
    isCapturing,
    isStartingCapture,
    onError,
    captureTokenRef,
    setIsStartingCapture,
    mountedRef,
    setIsCapturing,
    setCaptureMessage,
  ]);
  return beginCapture;
}

interface UseHotkeyOptions {
  hotkey: string;
  enabled: boolean;
  onSave: (hotkey: string) => void;
  onError: (message: string) => void;
}

function useCaptureCancellation(enabled: boolean, endCapture: () => void): void {
  const wasEnabled = useRef(enabled);
  useLayoutEffect(() => {
    if (wasEnabled.current && !enabled) {
      endCapture();
    }
    wasEnabled.current = enabled;
  }, [enabled, endCapture]);
  useEffect(() => {
    globalThis.addEventListener("blur", endCapture);
    return (): void => {
      globalThis.removeEventListener("blur", endCapture);
    };
  }, [endCapture]);
}

function useCaptureLifetime(
  mountedRef: RefObject<boolean>,
  captureTokenRef: RefObject<number>,
  cancellation: Readonly<{ enabled: boolean; endCapture: () => void }>,
): void {
  useCaptureCancellation(cancellation.enabled, cancellation.endCapture);
  useEffect(() => {
    mountedRef.current = true;
    // Tauri keeps the Rust state across frontend HMR. Clear a capture latch
    // Left behind if the previous webview was reloaded before its cleanup ran.
    const token = nextCaptureToken();
    captureTokenRef.current = token;
    void releaseCapture(token);

    return (): void => {
      mountedRef.current = false;
      const cleanupToken = nextCaptureToken();
      captureTokenRef.current = cleanupToken;
      void releaseCapture(cleanupToken);
    };
  }, [mountedRef, captureTokenRef]);
}

function captureHint(key: string): string {
  if (isModifierKey(key)) {
    return "Добавьте клавишу…";
  }
  return "Нужно поддерживаемое сочетание";
}

function applyCapturedKey(
  event: Readonly<
    Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">
  >,
  {
    endCapture,
    onSave,
    setCaptureMessage,
  }: Readonly<{
    endCapture: () => void;
    onSave: (hotkey: string) => void;
    setCaptureMessage: Dispatch<SetStateAction<string | null>>;
  }>,
): void {
  const result = formatHotkey(event);
  if (result === null) {
    setCaptureMessage(captureHint(event.key));
    return;
  }

  onSave(result);
  endCapture();
}
function useCaptureKeyboard({
  captureTokenRef,
  isCapturing,
  endCapture,
  onSave,
  setCaptureMessage,
}: Readonly<{
  captureTokenRef: RefObject<number>;
  isCapturing: boolean;
  endCapture: () => void;
  onSave: (hotkey: string) => void;
  setCaptureMessage: Dispatch<SetStateAction<string | null>>;
}>): void {
  useEffect(() => {
    const token = captureTokenRef.current;
    const handleKeyDown = (
      event: Readonly<
        Pick<
          KeyboardEvent,
          | "code"
          | "key"
          | "ctrlKey"
          | "altKey"
          | "shiftKey"
          | "metaKey"
          | "preventDefault"
          | "stopPropagation"
        >
      >,
    ): void => {
      if (token !== captureTokenRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        endCapture();
      } else {
        applyCapturedKey(event, { endCapture, onSave, setCaptureMessage });
      }
    };
    if (isCapturing) {
      globalThis.addEventListener("keydown", handleKeyDown, true);
    }
    return (): void => {
      globalThis.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [captureTokenRef, endCapture, isCapturing, onSave, setCaptureMessage]);
}

interface HotkeyResult {
  captureMessage: string | null;
  displayHotkey: string;
  handleClick: () => void;
  isCapturing: boolean;
  isStartingCapture: boolean;
}

function useCaptureRefs(): { captureTokenRef: RefObject<number>; mountedRef: RefObject<boolean> } {
  const captureTokenRef = useRef(INITIAL_TOKEN);
  const mountedRef = useRef(true);
  return { captureTokenRef, mountedRef };
}
export function useHotkey({
  hotkey,
  enabled,
  onSave,
  onError,
}: Readonly<UseHotkeyOptions>): HotkeyResult {
  const [isCapturing, setIsCapturing] = useState(false);
  const [isStartingCapture, setIsStartingCapture] = useState(false);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const { captureTokenRef, mountedRef } = useCaptureRefs();

  const endCapture = useEndCapture({
    captureTokenRef,
    mountedRef,
    onError,
    setCaptureMessage,
    setIsCapturing,
    setIsStartingCapture,
  });

  const beginCapture = useBeginCapture({
    captureTokenRef,
    enabled,
    isCapturing,
    isStartingCapture,
    mountedRef,
    onError,
    setCaptureMessage,
    setIsCapturing,
    setIsStartingCapture,
  });

  useCaptureLifetime(mountedRef, captureTokenRef, { enabled, endCapture });
  useCaptureKeyboard({ captureTokenRef, endCapture, isCapturing, onSave, setCaptureMessage });

  const handleClick = useCallback((): void => {
    if (isCapturing) {
      endCapture();
    } else {
      void beginCapture();
    }
  }, [isCapturing, beginCapture, endCapture]);

  return {
    captureMessage,
    displayHotkey: hotkey,
    handleClick,
    isCapturing,
    isStartingCapture,
  };
}
