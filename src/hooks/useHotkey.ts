import { useState, useCallback } from "react";
import { formatHotkey, isModifierKey } from "@/lib/hotkey";

interface UseHotkeyOptions {
  hotkey: string;
  onSave: (hotkey: string) => void;
}

export function useHotkey({ hotkey, onSave }: UseHotkeyOptions) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);

  const beginCapture = useCallback(() => {
    setIsCapturing(true);
    setCaptureMessage("Нажмите сочетание…");
  }, []);

  const endCapture = useCallback(() => {
    setIsCapturing(false);
    setCaptureMessage(null);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!isCapturing) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        endCapture();
        return;
      }

      const result = formatHotkey(event.nativeEvent);
      if (!result) {
        setCaptureMessage(
          isModifierKey(event.key)
            ? "Добавьте клавишу…"
            : "Нужно поддерживаемое сочетание",
        );
        return;
      }

      endCapture();
      onSave(result);
    },
    [isCapturing, endCapture, onSave],
  );

  const handleClick = useCallback(() => {
    if (isCapturing) {
      endCapture();
    } else {
      beginCapture();
    }
  }, [isCapturing, beginCapture, endCapture]);

  return {
    isCapturing,
    captureMessage,
    displayHotkey: hotkey,
    handleClick,
    handleKeyDown,
  };
}
