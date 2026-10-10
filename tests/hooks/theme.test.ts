import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, events, flush } from "./harness";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "../../src/hooks/useTheme";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
let bus = events();
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  bus = events();
  vi.mocked(listen).mockImplementation(bus.listen);
  vi.mocked(emit).mockResolvedValue();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- label-only Tauri window fixture
  vi.mocked(getCurrentWindow).mockReturnValue({ label: "main" } as unknown as ReturnType<
    typeof getCurrentWindow
  >);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("theme", () => {
  it("uses media fallback, toggles DOM/storage, and publishes current theme on request", async () => {
    const { result, unmount } = renderHook(() => useTheme());
    await flush();
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
    act(() => {
      result.current.toggleTheme();
    });
    await flush();
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
    expect(emit).toHaveBeenCalledWith("slovo://theme-changed", "light");
    bus.send("slovo://theme-request", null);
    await flush();
    expect(emit).toHaveBeenLastCalledWith("slovo://theme-changed", "light");
    unmount();
    expect(bus.dispose).toHaveBeenCalledOnce();
  });
  it("prefers saved theme, synchronizes storage and ignores unrelated keys", async () => {
    localStorage.setItem("theme", "light");
    const { result } = renderHook(() => useTheme());
    await flush();
    expect(result.current.theme).toBe("light");
    localStorage.setItem("theme", "dark");
    act(() => {
      globalThis.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    });
    expect(result.current.theme).toBe("light");
    act(() => {
      globalThis.dispatchEvent(new StorageEvent("storage", { key: "theme" }));
    });
    expect(result.current.theme).toBe("dark");
  });
  it("secondary windows subscribe before requesting theme and reject invalid events", async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- label-only Tauri window fixture
    vi.mocked(getCurrentWindow).mockReturnValue({ label: "correction" } as unknown as ReturnType<
      typeof getCurrentWindow
    >);
    localStorage.setItem("theme", "light");
    const { result } = renderHook(() => useTheme());
    await flush();
    expect(emit).toHaveBeenCalledWith("slovo://theme-request");
    bus.send("slovo://theme-changed", "dark");
    expect(result.current.theme).toBe("dark");
    bus.send("slovo://theme-changed", "invalid");
    expect(result.current.theme).toBe("dark");
  });
  it("keeps local functionality after IPC failure and disposes late subscriptions", async () => {
    vi.mocked(emit).mockRejectedValue("offline");
    vi.mocked(listen).mockRejectedValueOnce("offline");
    const { result, unmount } = renderHook(() => useTheme());
    await flush();
    act(() => {
      result.current.toggleTheme();
    });
    await flush();
    expect(result.current.theme).toBe("light");
    unmount();
    const late = deferred<() => void>();
    const dispose = vi.fn();
    vi.mocked(listen).mockReturnValueOnce(late.promise);
    const hook = renderHook(() => useTheme());
    hook.unmount();
    await act(async () => {
      late.resolve((): void => {
        dispose();
      });
      await late.promise;
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
