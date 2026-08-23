import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ServerAvailability } from "@/hooks/useServerAvailability";
import { normalizeHttpUrl } from "@/lib/url";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";

interface ServerUrlSettingProps {
  value: string;
  availability: ServerAvailability;
  onScheduleSave: (value: string) => void;
  onBlurSave: (value: string) => void;
  onCheckAvailability: (value: string) => void;
  onInvalidateAvailability: () => void;
}

function validateServerUrl(value: string): string | null {
  if (!value.trim()) return "Укажите адрес сервера.";
  if (normalizeHttpUrl(value) === null) {
    return "Введите полный адрес, включая http:// или https://.";
  }
  return null;
}

export function ServerUrlSetting({
  value,
  availability,
  onScheduleSave,
  onBlurSave,
  onCheckAvailability,
  onInvalidateAvailability,
}: ServerUrlSettingProps) {
  const [localValue, setLocalValue] = useState(value);
  const [error, setError] = useState("");

  // Sync from external value (e.g. after save roundtrip)
  useEffect(() => {
    if (document.activeElement?.id !== "server-url") {
      setLocalValue(value);
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setLocalValue(v);
    setError("");
    onInvalidateAvailability();
    onScheduleSave(v);
  };

  const handleBlur = () => {
    const message = validateServerUrl(localValue);
    setError(message ?? "");
    if (!message) {
      onBlurSave(localValue);
      onCheckAvailability(localValue);
    }
  };

  const availabilityView = {
    idle: null,
    checking: {
      text: "Проверяем доступность…",
      dotClass: "bg-muted-foreground animate-pulse",
      textClass: "text-muted-foreground",
    },
    available: {
      text: "Сервер доступен",
      dotClass: "bg-emerald-600 dark:bg-emerald-400",
      textClass: "text-emerald-700 dark:text-emerald-400",
    },
    unavailable: {
      text: "Сервер недоступен",
      dotClass: "bg-destructive",
      textClass: "text-destructive",
    },
  }[availability];

  return (
    <div className="space-y-2">
      <Label htmlFor="server-url">Сервер распознавания</Label>
      <Input
        id="server-url"
        type="url"
        placeholder="http://127.0.0.1:8072"
        spellCheck={false}
        autoComplete="off"
        value={localValue}
        onChange={handleChange}
        onBlur={handleBlur}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error
            ? "server-help server-error"
            : availabilityView
              ? "server-help server-availability"
              : "server-help"
        }
      />
      <div className="flex min-h-4 items-center justify-between gap-3 text-xs">
        <p id="server-help" className="text-muted-foreground">
          Полный адрес с http:// или https://
        </p>
        {!error && availabilityView && (
          <p
            id="server-availability"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5",
              availabilityView.textClass,
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                availabilityView.dotClass,
              )}
              aria-hidden="true"
            />
            {availabilityView.text}
          </p>
        )}
      </div>
      {error && (
        <p
          id="server-error"
          className="text-xs text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
