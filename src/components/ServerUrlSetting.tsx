import { FieldLabel } from "@/components/FieldLabel";
import { Input } from "@/components/ui/input";
import type { JSX } from "react";
import type { ServerAvailability } from "@/hooks/useServerAvailability";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useState } from "react";

interface ServerUrlSettingProps {
  readonly value: string;
  readonly availability: ServerAvailability;
  readonly onScheduleSave: (value: string) => void;
  readonly onBlurSave: (value: string) => void;
  readonly onCheckAvailability: (value: string) => void;
  readonly onInvalidateAvailability: () => void;
}

function validateServerUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "Укажите адрес сервера.";
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Invalid server URL");
    }
  } catch {
    return "Введите полный адрес, включая http:// или https://.";
  }
  return null;
}

const AVAILABILITY_VIEWS = {
  available: {
    dotClass: "bg-emerald-600 dark:bg-emerald-400",
    text: "Соединение установлено",
    textClass: "text-emerald-700 dark:text-emerald-400",
  },
  checking: {
    dotClass: "bg-muted-foreground animate-pulse",
    text: "Проверяем соединение…",
    textClass: "text-muted-foreground",
  },
  idle: null,
  unavailable: {
    dotClass: "bg-destructive",
    text: "Нет соединения",
    textClass: "text-destructive",
  },
} as const;

export function ServerUrlSetting({
  value,
  availability,
  onScheduleSave,
  onBlurSave,
  onCheckAvailability,
  onInvalidateAvailability,
}: ServerUrlSettingProps): JSX.Element | null {
  const [localValue, setLocalValue] = useState(value);
  const [error, setError] = useState("");

  const [previousValue, setPreviousValue] = useState(value);
  if (previousValue !== value) {
    setPreviousValue(value);
    if (document.activeElement?.id !== "server-url") {
      setLocalValue(value);
    }
  }

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const nextValue = event.target.value;
    setLocalValue(nextValue);
    setError("");
    onInvalidateAvailability();
    onScheduleSave(nextValue);
  };

  const handleBlur = (): void => {
    const message = validateServerUrl(localValue);
    setError(message ?? "");
    if (message === null) {
      onBlurSave(localValue);
      onCheckAvailability(localValue);
    }
  };

  const availabilityView = AVAILABILITY_VIEWS[availability];

  let describedBy = "server-help";
  if (availabilityView !== null) {
    describedBy = "server-help server-availability";
  }
  if (error !== "") {
    describedBy = "server-help server-error";
  }
  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-2">
        <FieldLabel
          htmlFor="server-url"
          label="Сервер распознавания"
          hint="Адрес сервера распознавания (Whisper или совместимого API), например http://127.0.0.1:8072"
        />
        <Input
          id="server-url"
          type="url"
          placeholder="http://127.0.0.1:8072"
          spellCheck={false}
          autoComplete="off"
          value={localValue}
          onChange={handleChange}
          onBlur={handleBlur}
          aria-invalid={error !== ""}
          aria-describedby={describedBy}
        />
        <div className="flex min-h-4 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
          <p id="server-help" className="text-muted-foreground">
            Полный адрес с http:// или https://
          </p>
          {error === "" && availabilityView !== null && (
            <output
              id="server-availability"
              aria-live="polite"
              aria-atomic="true"
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5",
                availabilityView.textClass,
              )}
            >
              <span
                className={cn("h-1.5 w-1.5 shrink-0 rounded-full", availabilityView.dotClass)}
                aria-hidden="true"
              />
              {availabilityView.text}
            </output>
          )}
        </div>
        {error && (
          <p id="server-error" className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}
