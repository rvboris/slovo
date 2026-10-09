import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../components/helpers";
import { useExitGuard } from "../../src/hooks/useExitGuard";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (command: string): Promise<unknown> => {
    await Promise.resolve();
    if (command === "correction_exit_ready") { return JSON.parse("null") as unknown; }
    return undefined;
  });
});

describe("useExitGuard", () => {
  it("approves a clean numeric event request", async () => {
    const onError = vi.fn<(message: string) => void>();
    const { result } = renderHook(() => useExitGuard(onError));
    await act(async () => { await result.current.probeReady(); });
    act(() => { result.current.applyExitRequest(41); });
    expect(invoke).toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 41 });
  });

  it("returns a pending numeric readiness snapshot", async () => {
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      await Promise.resolve();
      if (command === "correction_exit_ready") { return 44; }
      return undefined;
    });
    const onError = vi.fn<(message: string) => void>();
    const { result } = renderHook(() => useExitGuard(onError));
    await act(async () => { await result.current.probeReady(); });
    expect(invoke).toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 44 });
  });

  it("allows dirty discard but blocks approval while saving", async () => {
    const onError = vi.fn<(message: string) => void>();
    const { result } = renderHook(() => useExitGuard(onError));
    act(() => { result.current.notifyFormState(true, false); result.current.applyExitRequest(42); });
    await act(async () => { await result.current.resolveExit("approve"); });
    expect(invoke).toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 42 });

    const savingGuard = renderHook(() => useExitGuard(onError));
    act(() => { savingGuard.result.current.notifyFormState(true, true); savingGuard.result.current.applyExitRequest(43); });
    await act(async () => { await savingGuard.result.current.resolveExit("approve"); });
    expect(invoke).not.toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 43 });
  });

  it("does not auto-approve after cancellation when a save later completes", async () => {
    const onError = vi.fn<(message: string) => void>();
    const { result } = renderHook(() => useExitGuard(onError));
    act(() => { result.current.notifyFormState(true, true); result.current.applyExitRequest(43); });
    await act(async () => { await result.current.resolveExit("cancel"); });
    act(() => { result.current.notifyFormState(false, false); });
    expect(invoke).toHaveBeenCalledWith("resolve_exit_request", { decision: "cancel", requestId: 43 });
    expect(invoke).not.toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 43 });
  });

  it("ignores a late readiness response after cancellation", async () => {
    const ready = deferred<number | null>();
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      await Promise.resolve();
      if (command === "correction_exit_ready") { return ready.promise; }
      return undefined;
    });
    const onError = vi.fn<(message: string) => void>();
    const { result } = renderHook(() => useExitGuard(onError));
    const probe = result.current.probeReady();
    act(() => { result.current.applyExitRequest(44); });
    await act(async () => { await result.current.resolveExit("cancel"); });
    await act(async () => { ready.resolve(44); await probe; });
    expect(invoke).not.toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 44 });
  });

  it("sets synchronous mutation admission latch before approval IPC completes", async () => {
    const approval = deferred<unknown>();
    invoke.mockImplementation(async (command: string): Promise<unknown> => {
      await Promise.resolve();
      if (command === "correction_exit_ready") { return JSON.parse("null") as unknown; }
      return approval.promise;
    });
    const onError = vi.fn<(message: string) => void>();
    const { result } = renderHook(() => useExitGuard(onError));
    act(() => { result.current.applyExitRequest(45); });
    act(() => { void result.current.resolveExit("approve"); });
    expect(result.current.admitsFormMutation()).toBe(false);
    await act(async () => { approval.resolve("approved"); await approval.promise; });
    expect(result.current.admitsFormMutation()).toBe(false);
    expect(result.current.exitResolving).toBe(true);
  });
});
