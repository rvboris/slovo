import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { JSX } from "react";
import { Label } from "@/components/ui/label";
import type { Settings } from "@/lib/types";
import { cn } from "@/lib/utils";

type Correction = Readonly<Pick<Settings, "llmServerUrl" | "llmModel" | "llmApiKey" | "llmPrompt">>;
function cleanValue(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") { return null; }
  return trimmed;
}
function validCorrectionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "";
  } catch { return false; }
}
function feedback({ dirty, saved, saving, enabled, configured }: Readonly<{ dirty: boolean; saved: boolean; saving: boolean; enabled: boolean; configured: boolean }>): Readonly<{ buttonLabel: string; announcement: string; enabledLabel: string; requiredMark: string }> {
  let buttonLabel = "Сохранить";
  let announcement = "";
  if (dirty) { announcement = "Есть несохранённые изменения"; }
  if (saved) { buttonLabel = "Сохранено"; announcement = "Настройки корректировки сохранены"; }
  if (saving) { buttonLabel = "Сохраняю…"; announcement = "Сохраняю настройки корректировки…"; }
  let enabledLabel = "Выключена";
  if (configured) { enabledLabel = "Включена"; }
  let requiredMark = "";
  if (enabled) { requiredMark = " *"; }
  return { announcement, buttonLabel, enabledLabel, requiredMark };
}

function draftError(next: Readonly<Correction>): string {
  if (next.llmServerUrl === null) { return ""; }
  if (!validCorrectionUrl(next.llmServerUrl)) { return "Введите адрес http:// или https:// без логина и пароля в адресе."; }
  if (next.llmModel === null || next.llmPrompt === null) { return "Для корректировки укажите модель и инструкцию."; }
  return "";
}

function statusTone(url: string | null): string {
  if (url !== null && url !== "") { return "text-emerald-600 dark:text-emerald-400"; }
  return "text-muted-foreground";
}

export function CorrectionSetting({ settings, onSave, onDirtyChange, onCancel, locked, canMutate }: {
  readonly settings: Readonly<Settings>;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly locked?: boolean;
  readonly canMutate?: () => boolean;
  readonly onSave: (patch: Partial<Settings>) => Promise<void>;
  readonly onCancel?: () => void;
}) : JSX.Element | null {
  const [draft, setDraft] = useState<Correction>({ llmApiKey: settings.llmApiKey, llmModel: settings.llmModel, llmPrompt: settings.llmPrompt, llmServerUrl: settings.llmServerUrl });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const [previousSettings, setPreviousSettings] = useState(settings);
  if (settings !== previousSettings) {
    setPreviousSettings(settings);
    if (!dirty && !saving) { setDraft(settings); }
  }
  const change = (key: keyof Correction, value: string): void => {
    if (locked === true || canMutate?.() === false) { return; }
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setSaved(false);
    setError("");
    onDirtyChange?.(true);
  };
  const enabled = Boolean(draft.llmServerUrl?.trim());
  const handleSave = async (): Promise<void> => {
    if (locked === true || saving || canMutate?.() === false) { return; }
    const next: Correction = {
      llmApiKey: cleanValue(draft.llmApiKey),
      llmModel: cleanValue(draft.llmModel),
      llmPrompt: cleanValue(draft.llmPrompt),
      llmServerUrl: cleanValue(draft.llmServerUrl),
    };
    const message = draftError(next);
    if (message !== "") { setError(message); return; }
    setError("");
    setSaving(true);
    try {
      await onSave(next);
      setDraft(next);
      setDirty(false);
      setSaved(true);
    } catch { setError("Не удалось сохранить. Введённые данные сохранены в форме — попробуйте ещё раз."); }
    finally { setSaving(false); }
  };
  const { buttonLabel, announcement, enabledLabel, requiredMark } = feedback({ configured: Boolean(settings.llmServerUrl), dirty, enabled, saved, saving });
  return (
    <form noValidate className="space-y-4" onSubmit={(event: Readonly<{ preventDefault: () => void }>) => { event.preventDefault(); void handleSave(); }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Корректировка текста</h2>
        <span className={cn("text-xs font-medium", statusTone(settings.llmServerUrl))}>
          {enabledLabel}
        </span>
      </div>
      <div className="space-y-2"><Label htmlFor="llm-server-url">Адрес API{requiredMark}</Label><Input id="llm-server-url" value={draft.llmServerUrl ?? ""} autoComplete="off" onChange={(event) => { change("llmServerUrl", event.currentTarget.value); }} disabled={locked === true || saving} /></div>
      <div className="space-y-2"><Label htmlFor="llm-model">Модель{requiredMark}</Label><Input id="llm-model" value={draft.llmModel ?? ""} autoComplete="off" spellCheck={false} onChange={(event) => { change("llmModel", event.currentTarget.value); }} disabled={locked === true || saving} /></div>
      <div className="space-y-2"><Label htmlFor="llm-key">API-ключ · необязательно</Label><Input id="llm-key" type="password" value={draft.llmApiKey ?? ""} autoComplete="off" onChange={(event) => { change("llmApiKey", event.currentTarget.value); }} disabled={locked === true || saving} /></div>
      <div className="space-y-2"><Label htmlFor="llm-prompt">Инструкция{requiredMark}</Label><textarea id="llm-prompt" rows={6} className="block w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50" value={draft.llmPrompt ?? ""} spellCheck={false} onChange={(event) => { change("llmPrompt", event.currentTarget.value); }} disabled={locked === true || saving} /></div>
      {error && <div role="alert" className="text-sm text-destructive">{error}</div>}
      <output className="sr-only" aria-live="polite">{announcement}</output>
      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>Отмена</Button>}
        <Button type="submit" disabled={saving || locked === true || !dirty}>{buttonLabel}</Button>
      </div>
    </form>
  );
}
