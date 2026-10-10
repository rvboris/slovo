import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../components/helpers";
import { useExitGuard } from "../../src/hooks/useExitGuard";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => {
  invoke.mockReset();
});

it("suppresses cancelling events and snapshots through save completion", async () => {
  const cancel = deferred<unknown>();
  invoke.mockImplementation(async (command: string): Promise<unknown> => {
    await Promise.resolve();
    if (command === "correction_exit_ready") {
      return 71;
    }
    return cancel.promise;
  });
  const { result } = renderHook(() => useExitGuard(vi.fn<(message: string) => void>()));
  act(() => {
    result.current.notifyFormState(true, true);
    result.current.applyExitRequest(71);
  });
  act(() => {
    void result.current.resolveExit("cancel");
  });
  act(() => {
    result.current.applyExitRequest(71);
  });
  await act(async () => {
    await result.current.probeReady();
  });
  act(() => {
    result.current.notifyFormState(false, false);
  });
  expect(invoke).not.toHaveBeenCalledWith("resolve_exit_request", {
    decision: "approve",
    requestId: 71,
  });
  await act(async () => {
    cancel.resolve("cancelled");
    await cancel.promise;
  });
  expect(result.current.exitPending).toBe(false);
  act(() => {
    result.current.applyExitRequest(71);
  });
  expect(result.current.exitPending).toBe(false);
});

it("restores failed cancellation for retry", async () => {
  const cancel = deferred<unknown>();
  invoke.mockReturnValueOnce(cancel.promise).mockResolvedValue("cancelled");
  const { result } = renderHook(() => useExitGuard(vi.fn<(message: string) => void>()));
  act(() => {
    result.current.notifyFormState(true, false);
    result.current.applyExitRequest(72);
  });
  act(() => {
    void result.current.resolveExit("cancel");
  });
  await act(async () => {
    cancel.reject(new Error("offline"));
    await expect(cancel.promise).rejects.toThrow("offline");
  });
  expect(result.current.exitPending).toBe(true);
  await act(async () => {
    await result.current.resolveExit("cancel");
  });
  expect(result.current.exitPending).toBe(false);
  expect(invoke).toHaveBeenLastCalledWith("resolve_exit_request", {
    decision: "cancel",
    requestId: 72,
  });
});

it("does not replace a newer request when an older cancel fails", async () => {
  const cancel = deferred<unknown>();
  invoke.mockReturnValueOnce(cancel.promise).mockResolvedValue("cancelled");
  const { result } = renderHook(() => useExitGuard(vi.fn<(message: string) => void>()));
  act(() => {
    result.current.notifyFormState(true, false);
    result.current.applyExitRequest(73);
  });
  act(() => {
    void result.current.resolveExit("cancel");
  });
  act(() => {
    result.current.applyExitRequest(74);
  });
  await act(async () => {
    cancel.reject(new Error("offline"));
    await expect(cancel.promise).rejects.toThrow("offline");
  });
  expect(result.current.exitPending).toBe(true);
  await act(async () => {
    await result.current.resolveExit("cancel");
  });
  expect(invoke).toHaveBeenLastCalledWith("resolve_exit_request", {
    decision: "cancel",
    requestId: 74,
  });
});
