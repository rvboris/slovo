import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, events, flush } from "./harness";
import type { RenderHookResult } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useShortcutStatus } from "../../src/hooks/useShortcutStatus";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const ipc = vi.mocked(invoke);
const onError = vi.fn<(message: string, retry?: () => Promise<void>) => void>();
const onClearError = vi.fn<() => void>();
const onPermissionDenied = vi.fn<(denied: boolean) => void>();
let bus = events();
beforeEach(() => {
  vi.clearAllMocks();
  bus = events();
  vi.mocked(listen).mockImplementation(async (eventName, handler): Promise<() => void> => {
    const cleanup = await bus.listen(eventName, handler);
    return (): void => {
      cleanup();
    };
  });
});
function mount(): RenderHookResult<ReturnType<typeof useShortcutStatus>, undefined> {
  return renderHook(() => useShortcutStatus({ onClearError, onError, onPermissionDenied }));
}
describe("shortcut status", () => {
  it("loads active status and maps permission/device/failure events", async () => {
    ipc.mockResolvedValue({ state: "active" });
    const { result } = mount();
    await flush();
    await act(async () => {
      await result.current.loadShortcutStatus();
    });
    expect(result.current.status.view).toBe("active");
    bus.send("slovo://shortcut-status", { setupAvailable: true, state: "permission-denied" });
    expect(result.current.status.canSetup).toBe(true);
    expect(onPermissionDenied).toHaveBeenLastCalledWith(true);
    bus.send("slovo://shortcut-status", { state: "devices-unavailable" });
    expect(result.current.status.canRetry).toBe(true);
    bus.send("slovo://shortcut-status", { detail: " provider stopped ", state: "failed" });
    expect(result.current.status.text).toContain("provider stopped");
  });
  it("does not let a stale load response overwrite a newer event", async () => {
    const pending = deferred<{ state: string }>();
    ipc.mockReturnValue(pending.promise);
    const { result } = mount();
    await flush();
    let loading!: Promise<void>;
    act(() => {
      loading = result.current.loadShortcutStatus();
    });
    bus.send("slovo://shortcut-status", { state: "active" });
    await act(async () => {
      pending.resolve({ state: "failed" });
      await loading;
    });
    expect(result.current.status.view).toBe("active");
  });
  it("guards overlapping retries, clears busy after error, and supplies working retry", async () => {
    const pending = deferred<never>();
    ipc.mockReturnValueOnce(pending.promise).mockResolvedValue({ state: "active" });
    const { result } = mount();
    let retrying!: Promise<void>;
    act(() => {
      retrying = result.current.retryShortcutBackend();
    });
    expect(result.current.status.isBusy).toBe(true);
    await act(async () => {
      await result.current.retryShortcutBackend();
    });
    expect(ipc).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.reject("offline");
      await retrying;
    });
    expect(result.current.status.isBusy).toBe(false);
    const retry = onError.mock.calls[0]?.[1];
    if (retry === undefined) {
      throw new Error("Expected retry callback");
    }
    await act(async () => {
      await retry();
    });
    expect(result.current.status.view).toBe("active");
    expect(onClearError).toHaveBeenCalledOnce();
  });
  it("offers load retry and disposes normal/late subscriptions", async () => {
    ipc.mockRejectedValueOnce("offline").mockResolvedValue({ state: "active" });
    const { result, unmount } = mount();
    await flush();
    await act(async () => {
      await result.current.loadShortcutStatus();
    });
    expect(result.current.status.view).toBe("error");
    const retry = onError.mock.calls[0]?.[1];
    if (retry === undefined) {
      throw new Error("Expected retry callback");
    }
    await act(async () => {
      await retry();
    });
    unmount();
    expect(bus.dispose).toHaveBeenCalledOnce();
    const late = deferred<() => void>();
    const dispose = vi.fn();
    vi.mocked(listen).mockReturnValueOnce(late.promise);
    const another = mount();
    another.unmount();
    act(() => {
      late.resolve((): void => {
        dispose();
      });
    });
    await flush();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("reports event subscription rejection", async () => {
    vi.mocked(listen).mockRejectedValueOnce("events");
    mount();
    await flush();
    expect(onError).toHaveBeenCalledWith("Не удалось подключить отображение состояния сочетания.");
  });
});
