import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState, useEffect } from "react";

interface ServerUrlSettingProps {
  value: string;
  onScheduleSave: (value: string) => void;
  onBlurSave: (value: string) => void;
}

function validateServerUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Укажите адрес сервера.";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error();
  } catch {
    return "Введите полный адрес, включая http:// или https://.";
  }
  return null;
}

export function ServerUrlSetting({
  value,
  onScheduleSave,
  onBlurSave,
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
    onScheduleSave(v);
  };

  const handleBlur = () => {
    const message = validateServerUrl(localValue);
    setError(message ?? "");
    if (!message) {
      onBlurSave(localValue);
    }
  };

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
        aria-describedby="server-help server-error"
      />
      <p id="server-help" className="text-xs text-muted-foreground">
        Полный адрес с http:// или https://
      </p>
      {error && (
        <p id="server-error" className="text-xs text-destructive" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}
