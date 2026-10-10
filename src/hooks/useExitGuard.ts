import { useCallback, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";

type ExitDecision = "approve" | "cancel";
const GENERATION_START = 0;
const GENERATION_STEP = 1;

async function deliverExitDecision(decision: ExitDecision, requestId: number): Promise<boolean> {
  try {
    await invoke("resolve_exit_request", { decision, requestId });
    return true;
  } catch {
    return false;
  }
}

interface ExitGuardState {
  id: number | null;
  generation: number;
  ready: boolean;
  dirty: boolean;
  saving: boolean;
  resolving: boolean;
  readonly completed: Set<number>;
  readonly cancelling: Set<number>;
}

interface Actions {
  readonly setExitPending: (pending: boolean) => void;
  readonly setExitResolving: (resolving: boolean) => void;
  readonly onError: (message: string) => void;
}

interface DecisionContext {
  readonly decision: ExitDecision;
  readonly requestId: number;
  readonly generation: number;
  readonly guardRef: RefObject<ExitGuardState>;
  readonly actions: Actions;
}

function enterDecision(context: Readonly<DecisionContext>): void {
  const guard = context.guardRef.current;
  if (context.decision === "cancel") {
    guard.cancelling.add(context.requestId);
    guard.id = null;
    guard.generation += GENERATION_STEP;
    guard.resolving = false;
    context.actions.setExitPending(false);
    return;
  }
  guard.resolving = true;
  context.actions.setExitResolving(true);
}

function staleAfterDecision(context: Readonly<DecisionContext>): boolean {
  const guard = context.guardRef.current;
  if (context.decision === "cancel") {
    return guard.generation !== context.generation + GENERATION_STEP;
  }
  return guard.generation !== context.generation;
}

function handleUndelivered(context: Readonly<DecisionContext>): void {
  const guard = context.guardRef.current;
  if (context.decision === "cancel" && guard.id === null) {
    guard.id = context.requestId;
    guard.generation = context.generation;
    context.actions.setExitPending(true);
  }
  if (guard.id === context.requestId) {
    guard.resolving = false;
    context.actions.setExitResolving(false);
    context.actions.onError("Не удалось передать решение о выходе. Попробуйте ещё раз.");
  }
}

function markCompleted(context: Readonly<DecisionContext>): void {
  const guard = context.guardRef.current;
  if (context.decision === "cancel" && guard.id === null) {
    guard.completed.add(context.requestId);
  }
  if (context.decision === "approve" && guard.id === context.requestId) {
    guard.completed.add(context.requestId);
  }
}

type Decide = (decision: ExitDecision, requestId: number, generation: number) => Promise<void>;

function decisionAllowed(context: Readonly<DecisionContext>): boolean {
  const guard = context.guardRef.current;
  if (guard.id !== context.requestId || guard.generation !== context.generation) {
    return false;
  }
  if (guard.resolving || (context.decision === "approve" && guard.saving)) {
    return false;
  }
  return true;
}

function finishDecision(context: Readonly<DecisionContext>, delivered: boolean): void {
  const guard = context.guardRef.current;
  guard.cancelling.delete(context.requestId);
  if (delivered && context.decision === "cancel") {
    guard.completed.add(context.requestId);
  }
  if (staleAfterDecision(context)) {
    return;
  }
  if (!delivered) {
    handleUndelivered(context);
    return;
  }
  markCompleted(context);
}

function useExitDecision(guardRef: RefObject<ExitGuardState>, actions: Actions): Decide {
  return useCallback(
    async (decision, requestId, generation): Promise<void> => {
      const context: Readonly<DecisionContext> = {
        actions,
        decision,
        generation,
        guardRef,
        requestId,
      };
      if (!decisionAllowed(context)) {
        return;
      }
      enterDecision(context);
      finishDecision(context, await deliverExitDecision(decision, requestId));
    },
    [actions, guardRef],
  );
}

/** Accepts or revives pending exit requests; readiness is probed separately. */
function useExitRequests(
  guardRef: RefObject<ExitGuardState>,
  decide: Decide,
  setExitPending: (pending: boolean) => void,
): Readonly<{
  applyExitRequest: ExitGuard["applyExitRequest"];
  reconcile: (requestId: number | null) => void;
}> {
  const applyExitRequest = useCallback(
    (requestId: unknown): void => {
      const guard = guardRef.current;
      if (
        typeof requestId !== "number" ||
        !Number.isSafeInteger(requestId) ||
        guard.completed.has(requestId) ||
        guard.cancelling.has(requestId)
      ) {
        return;
      }
      if (guard.id === requestId) {
        return;
      }
      guard.id = requestId;
      guard.generation += GENERATION_STEP;
      setExitPending(true);
      if (guard.ready && !guard.dirty && !guard.saving) {
        void decide("approve", requestId, guard.generation);
      }
    },
    [decide, guardRef, setExitPending],
  );
  const reconcile = useCallback(
    (requestId: number | null): void => {
      const guard = guardRef.current;
      if (
        requestId !== null &&
        !(guard.completed.has(requestId) || guard.cancelling.has(requestId)) &&
        guard.id === null
      ) {
        guard.id = requestId;
        guard.generation += GENERATION_STEP;
        setExitPending(true);
      }
      if (guard.id !== null && guard.ready && !guard.dirty && !guard.saving) {
        void decide("approve", guard.id, guard.generation);
      }
    },
    [decide, guardRef, setExitPending],
  );
  return { applyExitRequest, reconcile };
}

function useExitReadiness(
  guardRef: RefObject<ExitGuardState>,
  reconcile: (requestId: number | null) => void,
): ExitGuard["probeReady"] {
  return useCallback(
    async (isCurrent = (): boolean => true): Promise<void> => {
      guardRef.current.ready = false;
      const snapshot = await invoke<number | null>("correction_exit_ready");
      if (!isCurrent()) {
        return;
      }
      guardRef.current.ready = true;
      reconcile(snapshot);
    },
    [guardRef, reconcile],
  );
}

/** User decisions and synchronous form-mutation admission on the same guard. */
function useExitControls(
  guardRef: RefObject<ExitGuardState>,
  decide: Decide,
): Readonly<{
  admitsFormMutation: ExitGuard["admitsFormMutation"];
  notifyFormState: ExitGuard["notifyFormState"];
  resolveExit: ExitGuard["resolveExit"];
}> {
  const resolveExit = useCallback(
    async (decision: ExitDecision): Promise<void> => {
      const guard = guardRef.current;
      const requestId = guard.id;
      if (requestId === null || (decision === "approve" && (guard.saving || guard.resolving))) {
        return;
      }
      await decide(decision, requestId, guard.generation);
    },
    [decide, guardRef],
  );
  const notifyFormState = useCallback(
    (dirty: boolean, saving: boolean): void => {
      const guard = guardRef.current;
      guard.dirty = dirty;
      guard.saving = saving;
      if (guard.id !== null && guard.ready && !dirty && !saving) {
        void decide("approve", guard.id, guard.generation);
      }
    },
    [decide, guardRef],
  );
  const admitsFormMutation = useCallback((): boolean => !guardRef.current.resolving, [guardRef]);
  return { admitsFormMutation, notifyFormState, resolveExit };
}

/** Tracks backend exit requests separately from form dirtiness and saving. */
function useExitGuard(onError: (message: string) => void): ExitGuard {
  const guardRef = useRef<ExitGuardState>({
    cancelling: new Set(),
    completed: new Set(),
    dirty: false,
    generation: GENERATION_START,
    id: null,
    ready: false,
    resolving: false,
    saving: false,
  });
  const [exitPending, setExitPending] = useState(false);
  const [exitResolving, setExitResolving] = useState(false);
  const actions = useMemo<Actions>(
    () => ({ onError, setExitPending, setExitResolving }),
    [onError],
  );
  const decide = useExitDecision(guardRef, actions);
  const { applyExitRequest, reconcile } = useExitRequests(guardRef, decide, setExitPending);
  const probeReady = useExitReadiness(guardRef, reconcile);
  const { admitsFormMutation, notifyFormState, resolveExit } = useExitControls(guardRef, decide);
  const admitsNavigation = useCallback(
    (): boolean =>
      guardRef.current.id === null && !guardRef.current.resolving && !guardRef.current.saving,
    [],
  );
  return {
    admitsFormMutation,
    admitsNavigation,
    applyExitRequest,
    exitPending,
    exitResolving,
    notifyFormState,
    probeReady,
    resolveExit,
  };
}

interface ExitGuard {
  readonly admitsNavigation: () => boolean;
  readonly exitPending: boolean;
  readonly exitResolving: boolean;
  readonly admitsFormMutation: () => boolean;
  readonly applyExitRequest: (requestId: unknown) => void;
  readonly probeReady: (isCurrent?: () => boolean) => Promise<void>;
  readonly resolveExit: (decision: ExitDecision) => Promise<void>;
  readonly notifyFormState: (dirty: boolean, saving: boolean) => void;
}

export { useExitGuard };
export type { ExitDecision, ExitGuard };
