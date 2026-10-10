import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, flush } from "./harness";
import { invoke } from "@tauri-apps/api/core";
import { usePermissionSetup } from "../../src/hooks/usePermissionSetup";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const ipc = vi.mocked(invoke);
const writeText = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  writeText.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});
const setup = {
  installCommands: ["install rule", " "],
  revokeCommands: ["remove rule"],
  supported: true,
};
describe("permission setup", () => {
  it("opens and loads once, gates installation acknowledgement, copies and resets labels", async () => {
    const pending = deferred<typeof setup>();
    ipc.mockReturnValue(pending.promise);
    const { result } = renderHook(() => usePermissionSetup());
    act(() => {
      result.current.open();
      result.current.open();
    });
    expect(result.current.visible).toBe(true);
    expect(ipc).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve(setup);
      await flush();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.installCommands).toEqual(["install rule"]);
    expect(result.current.copyInstallDisabled).toBe(true);
    act(() => {
      result.current.handleAckChange(true);
    });
    expect(result.current.copyInstallDisabled).toBe(false);
    await act(async () => {
      await result.current.copyCommands("install");
    });
    expect(writeText).toHaveBeenCalledWith("install rule");
    expect(result.current.copyInstallLabel).toBe("Скопировано");
    act(() => {
      vi.advanceTimersByTime(2200);
    });
    expect(result.current.copyInstallLabel).toBe("Копировать");
    expect(result.current.copyInstallDisabled).toBe(false);
    act(() => {
      result.current.close();
    });
    expect(result.current.visible).toBe(false);
    expect(result.current.setup).toBeNull();
    expect(result.current.ackChecked).toBe(false);
  });
  it("reports unsupported/error responses and clears loading guards for another open", async () => {
    ipc
      .mockRejectedValueOnce("offline")
      .mockResolvedValueOnce({ supported: false })
      .mockResolvedValue(setup);
    const { result } = renderHook(() => usePermissionSetup());
    act(() => {
      result.current.open();
    });
    await flush();
    expect(result.current.stateMessage).toBe("offline");
    expect(result.current.verifyDisabled).toBe(false);
    act(() => {
      result.current.open();
    });
    await flush();
    expect(result.current.stateMessage).toContain("не поддерживается");
    act(() => {
      result.current.open();
    });
    await flush();
    expect(result.current.setup).toEqual(setup);
  });
  it("retains legacy clipboard fallback and removes its temporary node even on failure", async () => {
    ipc.mockResolvedValue(setup);
    writeText.mockRejectedValue("denied");
    const legacy = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: legacy });
    const { result, unmount } = renderHook(() => usePermissionSetup());
    act(() => {
      result.current.open();
    });
    await flush();
    await act(async () => {
      await result.current.copyCommands("revoke");
    });
    expect(legacy).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
    expect(result.current.stateMessage).toContain("скопированы");
    legacy.mockImplementation(() => {
      throw new Error("blocked");
    });
    await act(async () => {
      await result.current.copyCommands("revoke");
    });
    expect(result.current.stateMessage).toContain("Выделите команды вручную");
    expect(document.querySelector("textarea")).toBeNull();
    unmount();
    act(() => {
      vi.runOnlyPendingTimers();
    });
  });
  it("does not copy absent commands and safely completes requests after unmount", async () => {
    const pending = deferred<typeof setup>();
    ipc.mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => usePermissionSetup());
    await act(async () => {
      await result.current.copyCommands("install");
    });
    expect(writeText).not.toHaveBeenCalled();
    act(() => {
      result.current.open();
    });
    unmount();
    await act(async () => {
      pending.resolve(setup);
      await flush();
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });
  });
});
