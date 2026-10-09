import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ExitGuard } from "@/hooks/useExitGuard";
import { listen } from "@tauri-apps/api/event";

interface CorrectionEventsOptions {
  readonly load: () => Promise<void>;
  readonly setError: (message: string) => void;
  readonly onConnected?: () => void;
  readonly applyExitRequest: ExitGuard["applyExitRequest"];
  readonly probeReady: ExitGuard["probeReady"];
}

/** Registers listeners before probing and exposes a cleanup-safe reconnect. */
type EventReconnect = () => Promise<void>;

interface RegistrationOptions {
  readonly cancelled: () => boolean;
  readonly addCleanup: (unlisten: () => void) => void;
  readonly load: () => Promise<void>;
  readonly probeReady: ExitGuard["probeReady"];
  readonly applyExitRequest: ExitGuard["applyExitRequest"];
}

async function listenForChanges(options: Readonly<RegistrationOptions>): Promise<void> {
  const unlisten = await listen("slovo://settings-changed", () => { void options.load(); });
  if (options.cancelled()) { unlisten(); return; }
  options.addCleanup(unlisten);
}

async function listenForExit(options: Readonly<RegistrationOptions>): Promise<void> {
  const unlisten = await listen<number>("slovo://exit-requested", (event) => { options.applyExitRequest(event.payload); });
  if (options.cancelled()) { unlisten(); return; }
  options.addCleanup(unlisten);
}

async function loadAndProbe(options: Readonly<RegistrationOptions>): Promise<void> {
  if (options.cancelled()) { return; }
  await options.load();
  if (!options.cancelled()) { await options.probeReady(() => !options.cancelled()); }
}

async function completeRegistration(options: Readonly<RegistrationOptions>): Promise<void> {
  if (options.cancelled()) { return; }
  await listenForExit(options);
  if (options.cancelled()) { return; }
  await loadAndProbe(options);
}

async function registerCorrectionListeners(options: Readonly<RegistrationOptions>): Promise<void> {
  await listenForChanges(options);
  if (!options.cancelled()) { await completeRegistration(options); }
}

interface SubscriptionContext {
  readonly registration: Readonly<RegistrationOptions>;
  readonly dispose: () => void;
  readonly isCancelled: () => boolean;
  readonly onConnected?: () => void;
  readonly setError: (message: string) => void;
}

async function runSubscription(context: SubscriptionContext): Promise<void> {
  try {
    await registerCorrectionListeners(context.registration);
    if (!context.isCancelled()) { context.onConnected?.(); }
  } catch {
    context.dispose();
    if (!context.isCancelled()) { context.setError("Не удалось подключить события окна."); }
  }
}

function connectEvents(options: Readonly<CorrectionEventsOptions>): { reconnect: EventReconnect; cleanup: () => void } {
    const { load, setError, onConnected, applyExitRequest, probeReady } = options;
    const lifecycle = { cancelled: false, reconnecting: false };
    const isCancelled = (): boolean => lifecycle.cancelled;
    const cleanup: (() => void)[] = [];
    const dispose = (): void => {
      for (const unlisten of cleanup) { unlisten(); }
      cleanup.length = 0;
    };
    const addCleanup = (unlisten: () => void): void => { cleanup.push(unlisten); };
    async function subscribe(): Promise<void> {
      if (lifecycle.reconnecting || isCancelled()) { return; }
      lifecycle.reconnecting = true;
      dispose();
      try {
        await runSubscription({ dispose, isCancelled, onConnected, registration: { addCleanup, applyExitRequest, cancelled: isCancelled, load, probeReady }, setError });
      } finally { lifecycle.reconnecting = false; }
    };
    return { cleanup: (): void => { lifecycle.cancelled = true; dispose(); }, reconnect: subscribe };
}

export function useCorrectionEvents(options: Readonly<CorrectionEventsOptions>): EventReconnect {
  const { load, setError, onConnected, applyExitRequest, probeReady } = options;
  const stableOptions = useMemo(() => ({ applyExitRequest, load, onConnected, probeReady, setError }), [load, setError, onConnected, applyExitRequest, probeReady]);
  const reconnectRef = useRef<EventReconnect>(async (): Promise<void> => { await Promise.resolve(); });
  useEffect(() => {
    const connection = connectEvents(stableOptions);
    reconnectRef.current = connection.reconnect;
    void connection.reconnect();
    return connection.cleanup;
  }, [stableOptions]);
  return useCallback(async (): Promise<void> => { await reconnectRef.current(); }, []);
}
