import type { JSX, RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CorrectionNotices } from "@/components/CorrectionNotices";
import { CorrectionSetting } from "@/components/CorrectionSetting";
import type { Settings } from '@/lib/types';
import { SlovoMark } from "@/components/SlovoMark";
import { X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";import { normalizeSettings } from '@/lib/types';
import { useCorrectionEvents } from "@/hooks/useCorrectionEvents";
import { useExitGuard } from "@/hooks/useExitGuard";
import { useTheme } from "@/hooks/useTheme";

type FailureKind = "load" | "connection";
const LOAD_ERROR = "Не удалось загрузить настройки.";
const CLOSE_ERROR = "Не удалось закрыть окно. Попробуйте ещё раз.";
/** Separate kinds so a retry targets the failure it belongs to. */
function useCorrectionFailures(): Readonly<{ clearFailure: (kind: FailureKind) => void; error: string; failure: FailureKind | null; reportFailure: (kind: FailureKind, message: string) => void; setError: (message: string) => void }> {
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const failureKind = useRef<FailureKind | null>(null);
  const reportFailure = useCallback((kind: FailureKind, message: string): void => {
    failureKind.current = kind;
    setFailure(kind);
    setError(message);
  }, []);
  const clearFailure = useCallback((kind: FailureKind): void => {
    if (failureKind.current !== kind) { return; }
    failureKind.current = null;
    setFailure(null);
    setError("");
  }, []);
  return { clearFailure, error, failure, reportFailure, setError };
}

function useConnectionReporting(reportFailure: (kind: FailureKind, message: string) => void, clearFailure: (kind: FailureKind) => void, setError: (message: string) => void): Readonly<{ handleConnected: () => void; reportCloseError: (message: string) => void; reportConnectionError: (message: string) => void }> {
  const reportConnectionError = useCallback((message: string): void => { reportFailure("connection", message); }, [reportFailure]);
  return { handleConnected: useCallback((): void => { clearFailure("connection"); }, [clearFailure]), reportCloseError: setError, reportConnectionError };
}

interface SaveContext {
  readonly admits: () => boolean;
  readonly dirty: RefObject<boolean>;
  readonly notify: (dirty: boolean, saving: boolean) => void;
  readonly request: RefObject<symbol>;
  readonly saving: RefObject<boolean>;
  readonly setConfirmClose: (confirm: boolean) => void;
  readonly setIsSaving: (saving: boolean) => void;
  readonly setSettings: (settings: Settings) => void;
}

async function saveCorrection(context: SaveContext, patch: Partial<Settings>): Promise<void> {
  if (!context.admits()) { throw new Error("Form locked while exit is being resolved"); }
  context.saving.current = true;
  context.setIsSaving(true);
  context.notify(context.dirty.current, true);
  context.request.current = Symbol("settings-request");
  try {
    const next = normalizeSettings(await invoke<Settings>("update_correction_settings", { correction: patch }));
    context.request.current = Symbol("settings-request");
    if (!context.admits()) { return; }
    context.setSettings(next);
    context.dirty.current = false;
    context.setConfirmClose(false);
    context.notify(false, true);
  } finally {
    context.saving.current = false;
    context.setIsSaving(false);
    context.notify(context.dirty.current, false);
  }
}

async function closeWindow(discard: boolean, onError: (message: string) => void): Promise<void> {
  try {
    if (discard) { await getCurrentWindow().destroy(); return; }
    await getCurrentWindow().close();
  } catch { onError(CLOSE_ERROR); }
}

export function CorrectionWindow() : JSX.Element | null {
  useTheme();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty = useRef(false);
  const saving = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const request = useRef(Symbol("settings-request"));
  const closeNotice = useRef<HTMLElement>(null);
  const { clearFailure, error, failure, reportFailure, setError } = useCorrectionFailures();
  const { handleConnected, reportCloseError, reportConnectionError } = useConnectionReporting(reportFailure, clearFailure, setError);
  const shouldConfirmClose = useCallback((): boolean => dirty.current || saving.current, []);
  const exitGuard = useExitGuard(setError);
  const load = useCallback(async (): Promise<void> => {
    const revision = Symbol("settings-request");
    request.current = revision;
    try {
      const next = normalizeSettings(await invoke<Settings>("get_settings"));
      if (revision === request.current) { setSettings(next); clearFailure("load"); }
    } catch { if (revision === request.current) { reportFailure("load", LOAD_ERROR); } }
  }, [clearFailure, reportFailure]);
  const { applyExitRequest, probeReady, admitsFormMutation, notifyFormState, exitPending, exitResolving, resolveExit } = exitGuard;
  const reconnect = useCorrectionEvents({ applyExitRequest, load, onCloseError: reportCloseError, onConnected: handleConnected, probeReady, setConfirmClose, setError: reportConnectionError, shouldConfirmClose });
  const retry = useCallback(async (): Promise<void> => {
    if (failure === "connection") { await reconnect(); return; }
    if (failure === "load") {
      // Bootstrap (no settings yet): re-establish listeners and load once.
      // Runtime refresh failure: listeners are healthy, retry the load only.
      if (settings === null) { await reconnect(); return; }
      await load();
    }
  }, [failure, load, reconnect, settings]);
  const retryLabel = "Повторить";

  const handleDirtyChange = useCallback((value: boolean): void => {
    if (!admitsFormMutation()) { return; }
    dirty.current = value;
    notifyFormState(value, saving.current);
  }, [admitsFormMutation, notifyFormState]);
  return (
    <main className="flex h-dvh flex-col overflow-hidden border border-border">
      <header className="titlebar flex h-10 shrink-0 items-center border-b border-border/80 bg-background/95 pl-4">
        <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-2">
          <div className="slovo-chip pointer-events-none flex h-7 w-7 shrink-0 items-center justify-center"><SlovoMark /></div>
          <h1 className="pointer-events-none truncate text-sm font-semibold tracking-tight">Слово · Корректировка</h1>
        </div>
        <button type="button" className="titlebar-control titlebar-close mr-1" aria-label="Закрыть окно" onClick={() => {
          void closeWindow(false, reportCloseError);
        }}><X className="h-4 w-4" aria-hidden="true" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {error !== "" && failure !== null && <div role="alert" className="mb-4 text-sm text-destructive">{error} <Button variant="outline" size="sm" onClick={() => { void retry(); }}>{retryLabel}</Button></div>}
      {error !== "" && failure === null && <div role="alert" className="mb-4 text-sm text-destructive">{error}</div>}
      <CorrectionNotices
        noticeRef={closeNotice}
        exitPending={exitPending}
        exitResolving={exitResolving}
        confirmClose={confirmClose}
        isSaving={isSaving}
        onCancelExit={() => { void resolveExit("cancel"); }}
        onApproveExit={() => { void resolveExit("approve"); }}
        onKeepEditing={() => { setConfirmClose(false); }}
        onDiscardClose={() => {
          if (saving.current) { return; }
          void closeWindow(true, reportCloseError);
        }}
      />
      {!settings && error === "" && <output className="block">Загрузка настроек…</output>}
      {settings && <CorrectionSetting settings={settings} locked={exitResolving} canMutate={admitsFormMutation} onDirtyChange={handleDirtyChange} onCancel={() => {
        if (!saving.current) { void closeWindow(true, reportCloseError); }
      }} onSave={async (patch) => { await saveCorrection({ admits: admitsFormMutation, dirty, notify: notifyFormState, request, saving, setConfirmClose, setIsSaving, setSettings }, patch); }} />}
      </div>
    </main>
  );
}
