import type { JSX, RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CorrectionNotices } from "@/components/CorrectionNotices";
import { CorrectionSetting } from "@/components/CorrectionSetting";
import type { Settings } from "@/lib/types";
import { invoke } from "@tauri-apps/api/core";
import { normalizeSettings } from "@/lib/types";
import { useCorrectionEvents } from "@/hooks/useCorrectionEvents";
import { useExitGuard } from "@/hooks/useExitGuard";

type FailureKind = "load" | "connection";
const LOAD_ERROR = "Не удалось загрузить настройки.";
/** Separate kinds so a retry targets the failure it belongs to. */
function useCorrectionFailures(): Readonly<{
  clearFailure: (kind: FailureKind) => void;
  error: string;
  failure: FailureKind | null;
  reportFailure: (kind: FailureKind, message: string) => void;
  setError: (message: string) => void;
}> {
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const failureKind = useRef<FailureKind | null>(null);
  const reportFailure = useCallback((kind: FailureKind, message: string): void => {
    failureKind.current = kind;
    setFailure(kind);
    setError(message);
  }, []);
  const clearFailure = useCallback((kind: FailureKind): void => {
    if (failureKind.current !== kind) {
      return;
    }
    failureKind.current = null;
    setFailure(null);
    setError("");
  }, []);
  return { clearFailure, error, failure, reportFailure, setError };
}

function useConnectionReporting(
  reportFailure: (kind: FailureKind, message: string) => void,
  clearFailure: (kind: FailureKind) => void,
): Readonly<{ handleConnected: () => void; reportConnectionError: (message: string) => void }> {
  const reportConnectionError = useCallback(
    (message: string): void => {
      reportFailure("connection", message);
    },
    [reportFailure],
  );
  return {
    handleConnected: useCallback((): void => {
      clearFailure("connection");
    }, [clearFailure]),
    reportConnectionError,
  };
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
  if (!context.admits()) {
    throw new Error("Form locked while exit is being resolved");
  }
  context.saving.current = true;
  context.setIsSaving(true);
  context.notify(context.dirty.current, true);
  context.request.current = Symbol("settings-request");
  try {
    const next = normalizeSettings(
      await invoke<Settings>("update_correction_settings", { correction: patch }),
    );
    context.request.current = Symbol("settings-request");
    if (!context.admits()) {
      return;
    }
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

// oxlint-disable-next-line max-statements -- Keep the existing exit/save controller mounted across both screens.
export function useCorrectionScreen(): Readonly<{
  content: JSX.Element | null;
  notices: JSX.Element;
  open: () => Promise<void>;
}> {
  const [visible, setVisible] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty = useRef(false);
  const saving = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const request = useRef(Symbol("settings-request"));
  const closeNotice = useRef<HTMLElement>(null);
  const { clearFailure, error, failure, reportFailure, setError } = useCorrectionFailures();
  const { handleConnected, reportConnectionError } = useConnectionReporting(
    reportFailure,
    clearFailure,
  );
  const exitGuard = useExitGuard(setError);
  const load = useCallback(async (): Promise<void> => {
    const revision = Symbol("settings-request");
    request.current = revision;
    try {
      const next = normalizeSettings(await invoke<Settings>("get_settings"));
      if (revision === request.current) {
        setSettings(next);
        clearFailure("load");
      }
    } catch {
      if (revision === request.current) {
        reportFailure("load", LOAD_ERROR);
      }
    }
  }, [clearFailure, reportFailure]);
  const {
    admitsNavigation,
    applyExitRequest,
    probeReady,
    admitsFormMutation,
    notifyFormState,
    exitPending,
    exitResolving,
    resolveExit,
  } = exitGuard;
  const reconnect = useCorrectionEvents({
    applyExitRequest,
    load,
    onConnected: handleConnected,
    probeReady,
    setError: reportConnectionError,
  });
  const retry = useCallback(async (): Promise<void> => {
    if (failure === "connection") {
      await reconnect();
      return;
    }
    if (failure === "load") {
      // Bootstrap (no settings yet): re-establish listeners and load once.
      // Runtime refresh failure: listeners are healthy, retry the load only.
      if (settings === null) {
        await reconnect();
        return;
      }
      await load();
    }
  }, [failure, load, reconnect, settings]);

  const handleDirtyChange = useCallback(
    (value: boolean): void => {
      if (!admitsFormMutation()) {
        return;
      }
      dirty.current = value;
      notifyFormState(value, saving.current);
    },
    [admitsFormMutation, notifyFormState],
  );
  const open = useCallback(async (): Promise<void> => {
    if (admitsNavigation()) {
      setVisible(true);
    }
    await Promise.resolve();
  }, [admitsNavigation]);
  const back = (): void => {
    if (saving.current || !admitsNavigation()) {
      return;
    }
    if (dirty.current) {
      setConfirmClose(true);
      return;
    }
    setVisible(false);
  };
  const notices = (
    <>
      {error !== "" && (
        <div
          role="alert"
          className="mx-6 space-y-3 rounded-md border border-destructive/30 p-4 text-sm"
        >
          <p>{error}</p>
          {failure !== null && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void retry();
              }}
            >
              Повторить
            </Button>
          )}
        </div>
      )}
      <CorrectionNotices
        noticeRef={closeNotice}
        exitPending={exitPending}
        exitResolving={exitResolving}
        confirmClose={confirmClose}
        isSaving={isSaving}
        onCancelExit={() => {
          void resolveExit("cancel");
        }}
        onApproveExit={() => {
          void resolveExit("approve");
        }}
        onKeepEditing={() => {
          setConfirmClose(false);
        }}
        onDiscardClose={() => {
          if (saving.current || !admitsNavigation()) {
            return;
          }
          dirty.current = false;
          notifyFormState(false, false);
          setConfirmClose(false);
          setVisible(false);
        }}
      />
    </>
  );
  let content: JSX.Element | null = null;
  if (visible) {
    content = (
      <section className="px-6 pb-6">
        {!settings && error === "" && <output className="block">Загрузка настроек…</output>}
        {settings && (
          <CorrectionSetting
            settings={settings}
            locked={exitResolving}
            canMutate={admitsFormMutation}
            onDirtyChange={handleDirtyChange}
            onCancel={back}
            onSave={async (patch) => {
              await saveCorrection(
                {
                  admits: admitsFormMutation,
                  dirty,
                  notify: notifyFormState,
                  request,
                  saving,
                  setConfirmClose,
                  setIsSaving,
                  setSettings,
                },
                patch,
              );
              if (admitsNavigation()) {
                setVisible(false);
              }
            }}
          />
        )}
      </section>
    );
  }
  return { content, notices, open };
}
