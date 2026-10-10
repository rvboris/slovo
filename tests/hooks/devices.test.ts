import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./harness";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const ipc = vi.mocked(invoke);
beforeEach(() => {
  vi.resetModules();
  ipc.mockReset();
});
describe("input device cache", () => {
  it("shares in-flight requests, caches successful devices, preserves unavailable selections, and forces refresh", async () => {
    const { useInputDevices } = await import("../../src/hooks/useInputDevices");
    const pending = deferred<{ name: string; isDefault: boolean }[]>();
    ipc.mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    const onError = vi.fn((): void => {
      void 0;
    });
    const first = renderHook(() => useInputDevices("missing", onError));
    const second = renderHook(() => useInputDevices(null, onError));
    expect(first.result.current.options).toContainEqual({ label: "missing", value: "missing" });
    let one!: Promise<void>;
    let two!: Promise<void>;
    act(() => {
      one = first.result.current.load();
      two = second.result.current.load();
    });
    expect(ipc).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve([
        { isDefault: false, name: " USB " },
        { isDefault: false, name: " " },
      ]);
      await Promise.all([one, two]);
    });
    expect(first.result.current.options).toContainEqual({ label: "USB", value: "USB" });
    expect(first.result.current.options).toContainEqual({
      label: "Недоступно: missing",
      value: "missing",
    });
    const third = renderHook(() => useInputDevices("USB", onError));
    await act(async () => {
      await third.result.current.load();
    });
    expect(ipc).toHaveBeenCalledTimes(1);
    await act(async () => {
      await third.result.current.reload();
    });
    expect(ipc).toHaveBeenCalledTimes(2);
    expect(third.result.current.options).toContainEqual({ label: "Недоступно: USB", value: "USB" });
  });
  it("clears failed request/loading guards so reload works", async () => {
    const { useInputDevices } = await import("../../src/hooks/useInputDevices");
    const onError = vi.fn((): void => {
      void 0;
    });
    ipc.mockRejectedValueOnce("offline").mockResolvedValue([{ isDefault: true, name: "Mic" }]);
    const { result } = renderHook(() => useInputDevices(null, onError));
    await act(async () => {
      await result.current.load();
    });
    expect(onError).toHaveBeenCalledWith("offline");
    expect(result.current.isLoading).toBe(false);
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.options).toContainEqual({ label: "Mic", value: "Mic" });
  });
  it("does not report late failures to an unmounted consumer", async () => {
    const { useInputDevices } = await import("../../src/hooks/useInputDevices");
    const onError = vi.fn((): void => {
      void 0;
    });
    const pending = deferred<never>();
    ipc.mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => useInputDevices(null, onError));
    let operation!: Promise<void>;
    act(() => {
      operation = result.current.load();
    });
    unmount();
    await act(async () => {
      pending.reject("late");
      await operation;
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
