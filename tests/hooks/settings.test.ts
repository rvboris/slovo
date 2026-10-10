import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, events, flush } from "./harness";
import { DEFAULT_SETTINGS } from "../../src/lib/types";
import type { RenderHookResult } from "@testing-library/react";
import type { Settings } from "../../src/lib/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "../../src/hooks/useSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const ipc = vi.mocked(invoke);
const onError = vi.fn<(message: string, retry?: () => Promise<void>) => void>();
const onClearError = vi.fn<() => void>();
let bus = events();
beforeEach(() => {
  vi.clearAllMocks();
  bus = events();
  vi.mocked(listen).mockImplementation(async (eventName, handler) => {
    const result = await bus.listen(eventName, handler);
    return result;
  });
});
afterEach(() => {
  vi.useRealTimers();
});
function mount(): RenderHookResult<ReturnType<typeof useSettings>, undefined> {
  return renderHook(() => useSettings({ onClearError, onError }));
}
describe("settings", () => {
  it("serializes patches and merges against the last persisted response", async () => {
    const first = deferred<Settings>();
    ipc.mockImplementation(async (command, args): Promise<unknown> => {
      if (command === "update_settings" && ipc.mock.calls.length === 1) {
        const result = await first.promise;
        return result;
      }
      if (
        !args ||
        typeof args !== "object" ||
        !("settings" in args) ||
        typeof args.settings !== "object" ||
        args.settings === null
      ) {
        throw new Error("Missing settings args");
      }
      const response = await Promise.resolve(args.settings);
      return response;
    });
    const { result } = mount();
    let saved!: Promise<void>;
    let next!: Promise<void>;
    act(() => {
      saved = result.current.saveSettings({ hotkey: "Ctrl+KeyA" });
      next = result.current.saveSettings({ llmModel: "real-model" });
    });
    await flush();
    expect(ipc).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve({ ...DEFAULT_SETTINGS, hotkey: "Ctrl+KeyA" });
      await saved;
      await next;
    });
    expect(ipc).toHaveBeenLastCalledWith("update_settings", {
      settings: { ...DEFAULT_SETTINGS, hotkey: "Ctrl+KeyA", llmModel: "real-model" },
    });
    expect(result.current.settings.llmModel).toBe("real-model");
  });
  it("rolls back failed saves, exposes a retry for the same patch, and keeps the queue usable", async () => {
    ipc
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async (_command, args): Promise<unknown> => {
        if (!args || typeof args !== "object" || !("settings" in args)) {
          throw new Error("Missing settings args");
        }
        const response = await Promise.resolve(args.settings);
        return response;
      });
    const { result } = mount();
    await act(async () => {
      await expect(result.current.saveSettings({ llmPrompt: "fix" })).rejects.toThrow("offline");
    });
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
    const retry = onError.mock.calls[0]?.[1];
    if (!retry) {
      throw new Error("Missing settings retry callback");
    }
    await act(async () => {
      await retry();
    });
    expect(result.current.settings.llmPrompt).toBe("fix");
    await act(async () => {
      await result.current.saveSettings({ inputDevice: "Mic" });
    });
    expect(result.current.settings.inputDevice).toBe("Mic");
  });
  it("ignores a stale load after a save and older overlapping loads", async () => {
    const old = deferred<Settings>();
    const newer = deferred<Settings>();
    ipc.mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise);
    const { result } = mount();
    let one!: Promise<void>;
    let two!: Promise<void>;
    act(() => {
      one = result.current.loadSettings();
      two = result.current.loadSettings();
    });
    await flush();
    await act(async () => {
      newer.resolve({ ...DEFAULT_SETTINGS, hotkey: "new" });
      await two;
      old.resolve({ ...DEFAULT_SETTINGS, hotkey: "old" });
      await one;
    });
    expect(result.current.settings.hotkey).toBe("new");
    const stale = deferred<Settings>();
    ipc
      .mockReturnValueOnce(stale.promise)
      .mockImplementation(async (_command, args): Promise<unknown> => {
        if (!args || typeof args !== "object" || !("settings" in args)) {
          throw new Error("Missing settings args");
        }
        const response = await Promise.resolve(args.settings);
        return response;
      });
    act(() => {
      one = result.current.loadSettings();
    });
    await flush();
    await act(async () => {
      await result.current.saveSettings({ hotkey: "saved" });
      stale.resolve(DEFAULT_SETTINGS);
      await one;
    });
    expect(result.current.settings.hotkey).toBe("saved");
  });
  it("debounces valid URLs and immediate save cancels the pending edit", async () => {
    vi.useFakeTimers();
    ipc.mockImplementation(async (_command, args): Promise<unknown> => {
      if (!args || typeof args !== "object" || !("settings" in args)) {
        throw new Error("Missing settings args");
      }
      const response = await Promise.resolve(args.settings);
      return response;
    });
    const { result } = mount();
    act(() => {
      result.current.scheduleServerSave("http://old");
      result.current.scheduleServerSave("http://new");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
    });
    expect(ipc).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.settings.serverUrl).toBe("http://new");
    act(() => {
      result.current.scheduleServerSave("http://later");
      result.current.saveServerNow("https://now");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.settings.serverUrl).toBe("https://now");
    act(() => {
      result.current.saveServerNow("file:///bad");
    });
    await flush();
    expect(ipc).toHaveBeenCalledTimes(2);
  });
  it("loads cross-window changes, reports load failure with retry, and disposes subscriptions", async () => {
    ipc.mockRejectedValueOnce("offline").mockResolvedValue(DEFAULT_SETTINGS);
    const { result, unmount } = mount();
    await flush();
    await act(async () => {
      await result.current.loadSettings();
    });
    expect(onError).toHaveBeenCalled();
    const retry = onError.mock.calls[0]?.[1];
    if (retry === undefined) {
      throw new Error("Missing retry callback");
    }
    await act(async () => {
      await retry();
    });
    expect(result.current.isLoaded).toBe(true);
    bus.send("slovo://settings-changed", null);
    await flush();
    expect(ipc).toHaveBeenCalledTimes(3);
    unmount();
    expect(bus.dispose).toHaveBeenCalledOnce();
  });
  it("disposes a subscription that completes after unmount and reports subscription failure", async () => {
    const pending = deferred<() => void>();
    const dispose = vi.fn();
    vi.mocked(listen).mockReturnValueOnce(pending.promise);
    const { unmount } = mount();
    unmount();
    await act(async () => {
      pending.resolve(() => {
        dispose();
      });
      await pending.promise;
    });
    expect(dispose).toHaveBeenCalledOnce();
    vi.mocked(listen).mockRejectedValueOnce(new Error("events"));
    mount();
    await flush();
    expect(onError).toHaveBeenCalledWith("Не удалось подключить обновление настроек.");
  });
});
