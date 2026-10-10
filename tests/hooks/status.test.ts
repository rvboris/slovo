import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, events, flush } from "./harness";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStatus } from "../../src/hooks/useStatus";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
let bus = events();
const onError = vi.fn<(message: string) => void>();
beforeEach(() => {
  vi.clearAllMocks();
  bus = events();
  vi.mocked(listen).mockImplementation(bus.listen);
  vi.mocked(invoke).mockResolvedValue({ kind: "ready", revision: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});
describe("revision-aware status", () => {
  it("does not reset terminal status or details after four seconds", async () => {
    vi.useFakeTimers();
    const view = renderHook(() => useStatus(onError));
    await flush();
    bus.send("slovo://status", { kind: "error", message: "offline", revision: 1 });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(view.result.current.kind).toBe("error");
    expect(view.result.current.operationalError).toContain("offline");
    bus.send("slovo://status", { kind: "copied", revision: 2 });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(view.result.current.kind).toBe("copied");
    expect(view.result.current.operationalError).toContain("offline");
  });
  it("retains result and independent details until explicit dismissal", async () => {
    const { result } = renderHook(() => useStatus(onError));
    await flush();
    bus.send("slovo://status", { kind: "error", message: "microphone unavailable", revision: 1 });
    expect(result.current.text).toBe("Ошибка — подробности в главном окне");
    expect(result.current.operationalError).toContain("microphone unavailable");
    bus.send("slovo://status", {
      correctionWarning: "timeout",
      kind: "copied",
      message: "x".repeat(5000),
      revision: 2,
    });
    expect(result.current.text).toBe("Скопировано — вставьте вручную · Без корректировки");
    expect(result.current.warning).toContain("timeout");
    expect(result.current.operationalError).toContain("microphone unavailable");
    bus.send("slovo://status", { elapsedSeconds: 65, kind: "recording", revision: 3 });
    expect(result.current.text).toBe("Слушаю · 01:05");
    expect(result.current.warning).toContain("timeout");
    expect(result.current.operationalError).toContain("microphone unavailable");
    act(() => {
      result.current.dismissWarning();
      result.current.dismissOperationalError();
    });
    expect(result.current.warning).toBe("");
    expect(result.current.operationalError).toBe("");
    expect(onError).not.toHaveBeenCalled();
  });
  it("registers before snapshot and accepts a newer snapshot after a live event", async () => {
    const registration = deferred<() => void>();
    const snapshot = deferred<unknown>();
    vi.mocked(listen).mockReturnValueOnce(registration.promise);
    vi.mocked(invoke).mockReturnValue(snapshot.promise);
    const view = renderHook(() => useStatus(onError));
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => {
      registration.resolve(vi.fn<() => void>());
      await registration.promise;
    });
    expect(invoke).toHaveBeenCalledWith("get_status");
    const listener = vi.mocked(listen).mock.calls[0]?.[1];
    act(() => {
      listener({ event: "slovo://status", id: 0, payload: { kind: "recording", revision: 1 } });
    });
    await act(async () => {
      snapshot.resolve({ kind: "inserted", revision: 2 });
      await snapshot.promise;
    });
    expect(view.result.current.kind).toBe("inserted");
  });
  it("ignores stale snapshots and duplicate revisions", async () => {
    const snapshot = deferred<unknown>();
    vi.mocked(invoke).mockReturnValue(snapshot.promise);
    const view = renderHook(() => useStatus(onError));
    await flush();
    bus.send("slovo://status", { kind: "correcting", revision: 3 });
    await act(async () => {
      snapshot.resolve({ kind: "recording", revision: 2 });
      await snapshot.promise;
    });
    bus.send("slovo://status", { kind: "error", message: "obsolete", revision: 3 });
    expect(view.result.current.kind).toBe("correcting");
    expect(view.result.current.operationalError).toBe("");
  });
  it("disposes late registration without loading a snapshot", async () => {
    const registration = deferred<() => void>();
    const dispose = vi.fn<() => void>();
    vi.mocked(listen).mockReturnValueOnce(registration.promise);
    const view = renderHook(() => useStatus(onError));
    view.unmount();
    await act(async () => {
      registration.resolve(dispose);
      await registration.promise;
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("ignores a snapshot after cleanup and reports synchronization failure separately", async () => {
    const snapshot = deferred<unknown>();
    vi.mocked(invoke).mockReturnValueOnce(snapshot.promise);
    const view = renderHook(() => useStatus(onError));
    await flush();
    view.unmount();
    await act(async () => {
      snapshot.resolve({ kind: "error", message: "late", revision: 1 });
      await snapshot.promise;
    });
    expect(onError).not.toHaveBeenCalled();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("offline"));
    const next = renderHook(() => useStatus(onError));
    await flush();
    expect(next.result.current.kind).toBe("ready");
    expect(onError).toHaveBeenCalledWith("Не удалось синхронизировать состояние.");
  });
});
