import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusPayload } from "../../src/lib/types";
import { deferred } from "../components/helpers";

const api = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let revision = 0;
const context = { clearRect: vi.fn(), createLinearGradient: vi.fn(), createRadialGradient: vi.fn(), fillRect: vi.fn(), fillStyle: "", scale: vi.fn() };
function emit(name: string, payload: unknown): void {
  revision += 1;
  let value = payload;
  if (name === "status" && typeof payload === "object" && payload !== null) { value = { revision, ...payload }; }
  handlers.get(`slovo://${name}`)?.({ payload: value });
}
function frame(): void {
  const entry = frames.entries().next().value;
  if (!entry) { throw new Error("No scheduled frame"); }
  frames.delete(entry[0]); entry[1](performance.now());
}
function element(id: string): HTMLElement {
  const result = document.querySelector<HTMLElement>(`#${id}`);
  if (!result) { throw new Error(`Missing ${id}`); }
  return result;
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  handlers.clear(); frames.clear(); nextFrame = 0; revision = 0;
  document.body.innerHTML = '<div class="recording-indicator"><div id="recording-state"><time id="recording-time"></time><canvas id="voice-canvas"></canvas></div><div id="error-state" hidden><span id="error-label"></span></div><div id="processing-state" hidden><span id="processing-label"></span></div></div>';
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("light") }));
  vi.stubGlobal("devicePixelRatio", 3);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { nextFrame += 1; frames.set(nextFrame, callback); return nextFrame; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { frames.delete(id); }));
  context.createRadialGradient.mockReturnValue({ addColorStop: vi.fn() });
  context.createLinearGradient.mockReturnValue({ addColorStop: vi.fn() });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the canvas stub only implements the methods recording uses.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  api.listen.mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void): Promise<() => void> => { handlers.set(name, callback); await Promise.resolve(); return vi.fn<() => void>(); });
  api.invoke.mockReset().mockResolvedValue({ kind: "ready", revision: 0 });
});
afterEach(() => { globalThis.dispatchEvent(new Event("pagehide")); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("recording entrypoint", { timeout: 15_000 }, () => {
  it("keeps concise results, ignores diagnostics, and accepts a newer recording", async () => {
    await import("../../src/recording"); await Promise.resolve(); await Promise.resolve();
    emit("status", { correctionWarning: "timeout", kind: "copied", message: "x".repeat(5000) });
    expect(element("processing-label")).toHaveTextContent("Скопировано — вставьте вручную · Без корректировки");
    expect(document.body).not.toHaveTextContent("xxx");
    vi.advanceTimersByTime(5000);
    expect(element("processing-state")).toBeVisible();
    emit("status", { kind: "recording" });
    expect(element("recording-state")).toBeVisible();
    expect(element("processing-state")).not.toBeVisible();
  });
  it("registers before snapshot and accepts newer snapshot after live status", async () => {
    const registration = deferred<() => void>(); const snapshot = deferred<StatusPayload>();
    api.listen.mockImplementationOnce(async (): Promise<() => void> => { await Promise.resolve(); return vi.fn<() => void>(); });
    api.listen.mockImplementationOnce(async (name: string, callback: (event: { payload: unknown }) => void): Promise<() => void> => { handlers.set(name, callback); await Promise.resolve(); return registration.promise; });
    api.invoke.mockReturnValue(snapshot.promise);
    await import("../../src/recording");
    expect(api.invoke).not.toHaveBeenCalled();
    registration.resolve(vi.fn<() => void>()); await Promise.resolve(); await Promise.resolve();
    expect(api.invoke).toHaveBeenCalledWith("get_status");
    emit("status", { kind: "recording", revision: 1 });
    snapshot.resolve({ kind: "copied", revision: 2 }); await Promise.resolve(); await Promise.resolve();
    expect(element("processing-label")).toHaveTextContent("Скопировано — вставьте вручную");
  });
  it("disposes late status registration without requesting a snapshot", async () => {
    const registration = deferred<() => void>(); const dispose = vi.fn<() => void>();
    api.listen.mockImplementationOnce(async (): Promise<() => void> => { await Promise.resolve(); return vi.fn<() => void>(); });
    api.listen.mockReturnValueOnce(registration.promise);
    await import("../../src/recording");
    globalThis.dispatchEvent(new Event("pagehide"));
    registration.resolve(dispose); await Promise.resolve(); await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    expect(api.invoke).not.toHaveBeenCalled();
  });
  it("ignores a snapshot delivered after page cleanup", async () => {
    const snapshot = deferred<StatusPayload>(); api.invoke.mockReturnValue(snapshot.promise);
    await import("../../src/recording"); await Promise.resolve(); await Promise.resolve();
    globalThis.dispatchEvent(new Event("pagehide"));
    snapshot.resolve({ kind: "recording", revision: 10 }); await Promise.resolve(); await Promise.resolve();
    expect(element("recording-state")).not.toBeVisible();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("hydrates elapsed time, draws audio and stops timers/frames across actual status events", async () => {
    api.invoke.mockResolvedValue({ elapsedSeconds: 61.8, kind: "recording", revision: 0 });
    await import("../../src/recording");
    await Promise.resolve(); await Promise.resolve();
    expect(api.listen).toHaveBeenCalledTimes(2);
    expect(api.invoke).toHaveBeenCalledWith("get_status");
    expect(element("recording-time")).toHaveTextContent("01:01");
    expect(element("recording-time")).toHaveAttribute("datetime", "PT61S");
    expect(element("voice-canvas")).toHaveAttribute("width", "336");
    expect(context.scale).toHaveBeenCalledWith(2, 2);
    vi.advanceTimersByTime(1250);
    expect(element("recording-time")).toHaveTextContent("01:03");
    emit("audio-level", { level: 1 }); frame();
    expect(context.fillRect).toHaveBeenCalled();
    expect(frames.size).toBe(1);
    emit("status", { elapsedSeconds: 5, kind: "recording" });
    expect(vi.getTimerCount()).toBe(1);
    expect(frames.size).toBe(1);
    emit("status", { kind: "transcribing" });
    expect(element("recording-state")).not.toBeVisible();
    expect(element("processing-label")).toHaveTextContent("Распознаю…");
    expect(element("processing-state")).toBeVisible();
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
    expect(element("recording-time")).toHaveTextContent("00:00");
    emit("status", { kind: "correcting" });
    expect(element("processing-label")).toHaveTextContent("Корректирую…");
    emit("status", { kind: "error", message: "Network offline" });
    expect(element("error-state")).toBeVisible();
    expect(element("error-state")).toHaveAttribute("aria-label", "Ошибка — подробности в главном окне");
    expect(element("processing-state")).not.toBeVisible();
    emit("status", { kind: "error" });
    expect(element("error-state")).toHaveAttribute("aria-label", "Ошибка — подробности в главном окне");
    emit("status", { kind: "ready" });
    expect(element("error-state")).not.toBeVisible();
    emit("audio-level", { level: 1 });
    expect(frames.size).toBe(0);
    emit("status", { kind: "recording" });
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(["resolve", "reject"] as const)("does not let a late initial %s overwrite live status", async (outcome) => {
    const pending = deferred<StatusPayload>();
    api.invoke.mockReturnValue(pending.promise);
    await import("../../src/recording");
    emit("status", { kind: "correcting" });
    if (outcome === "resolve") { pending.resolve({ kind: "recording", revision: 0 }); } else { pending.reject(new Error("offline")); }
    await Promise.resolve(); await Promise.resolve();
    expect(element("processing-state")).toBeVisible();
    expect(element("recording-state")).not.toBeVisible();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports synchronization failure without inventing recording, including without canvas support", async () => {
    api.invoke.mockRejectedValue(new Error("offline"));
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    getContext.mockReturnValue(null);
    await import("../../src/recording");
    await Promise.resolve(); await Promise.resolve();
    expect(element("recording-state")).not.toBeVisible();
    expect(element("error-label")).toHaveTextContent("Не удалось синхронизировать состояние");
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
    emit("status", { kind: "inserted" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports reduced motion and ignores malformed audio payloads", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    api.invoke.mockResolvedValue({ kind: "recording", revision: 0 });
    await import("../../src/recording");
    frame();
    expect(context.fillRect).not.toHaveBeenCalled();
    emit("audio-level", { level: 0.8 }); frame();
    expect(context.fillRect).toHaveBeenCalled();
    for (const payload of [null, "bad", {}, { level: "bad" }]) { emit("audio-level", payload); if (frames.size > 0) { frame(); } }
    expect(element("recording-state")).toBeVisible();
    emit("status", { kind: "copied" });
    expect(frames.size).toBe(0);
  });

  it("fails explicitly when overlay markup is missing", async () => {
    document.body.innerHTML = "";
    await expect(import("../../src/recording")).rejects.toThrow("Missing recording overlay elements");
    expect(api.listen).not.toHaveBeenCalled();
  });
});
