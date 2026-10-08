
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, settings } from "../components/helpers";
import { App } from "../../src/App";
import type { Settings } from "../../src/lib/types";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ close: vi.fn(), emit: vi.fn(), invoke: vi.fn(), listen: vi.fn(), minimize: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: api.emit, listen: api.listen }));
vi.mock("@tauri-apps/api/window", (): { getCurrentWindow: () => { close: typeof api.close; label: string; minimize: typeof api.minimize } } => ({ getCurrentWindow: (): { close: typeof api.close; label: string; minimize: typeof api.minimize } => ({ close: api.close, label: "main", minimize: api.minimize }) }));
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const disposers: ReturnType<typeof vi.fn>[] = [];
let current: Settings;
let rejectNextSettingsUpdate = false;
let shortcutStatus: { state: string; setupAvailable?: boolean } = { state: "active" };
let statusRevision = 0;
function emit(name: string, payload: object): void {
  statusRevision += 1;
  let value = payload;
  if (name === "status") { value = { revision: statusRevision, ...payload }; }
  listeners.get(`slovo://${name}`)?.({ payload: value });
}
beforeEach(() => {
  vi.clearAllMocks(); listeners.clear(); disposers.length = 0; current = { ...settings }; rejectNextSettingsUpdate = false; shortcutStatus = { state: "active" };
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  api.emit.mockResolvedValue(null);
  api.listen.mockImplementation((name: string, callback: (event: { payload: unknown }) => void) => { listeners.set(name, callback); const dispose = vi.fn(); disposers.push(dispose); return dispose; });
  api.invoke.mockReset().mockImplementation((command: string, args?: { settings?: Partial<Settings> }) => {
    switch (command) {
      case "get_status": { return { kind: "ready", revision: 0 }; }
      case "get_settings": { return current;
      }
      case "get_shortcut_backend_status": case "retry_shortcut_backend": { return shortcutStatus; }
      case "check_server_url": { return true;
      }
      case "get_input_devices": { return [];
      }
      case "update_settings": { if (rejectNextSettingsUpdate) { rejectNextSettingsUpdate = false; throw new Error("settings update failed"); } current = { ...current, ...args?.settings }; return current;
      }
      case "open_correction_settings": { return null;
      }
      case "get_shortcut_permission_setup": { return { installCommands: ["install rule"], revokeCommands: ["remove rule"], supported: true };
      }
      default: { return null;
      }
    }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("App and AppView integration", () => {
  it("retains dictation error through a new recording and successful settings save until dismissed", async () => {
    const user = userEvent.setup(); render(<App />);
    await screen.findByText("Сочетание активно");
    act(() => { emit("status", { kind: "error", message: "Microphone unavailable" }); });
    act(() => { emit("status", { kind: "recording" }); });
    expect(screen.getByRole("alert")).toHaveTextContent("Ошибка предыдущей операции: Microphone unavailable");
    act(() => { emit("status", { kind: "ready" }); });
    await user.click(screen.getByRole("button", { name: "Сочетание клавиш" }));
    await user.keyboard("{Control>}k{/Control}");
    await waitFor(() => { expect(current.hotkey).toBe("Ctrl+KeyK"); });
    expect(screen.getByRole("alert")).toHaveTextContent("Microphone unavailable");
    await user.click(screen.getByRole("button", { name: "Скрыть ошибку предыдущей операции" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it.each(["recording", "transcribing", "correcting"])("blocks hotkey editing during %s and cancels capture", async (kind) => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Сочетание активно");
    const control = screen.getByRole("button", { name: "Сочетание клавиш" });
    await user.click(control);
    expect(control).toHaveAttribute("aria-pressed", "true");
    await act(async () => { emit("status", { elapsedSeconds: 1, kind }); await Promise.resolve(); });
    expect(control).toBeDisabled();
    expect(control).toHaveAttribute("aria-pressed", "false");
    const previous = current.hotkey;
    await user.keyboard("{Control>}k{/Control}");
    expect(current.hotkey).toBe(previous);
    await act(async () => { emit("status", { kind: "ready" }); await Promise.resolve(); });
    expect(control).toBeEnabled();
    await user.click(control);
    expect(control).toHaveAttribute("aria-pressed", "true");
  });
  it("gates controls during bootstrap, routes edits to IPC and opens correction settings", async () => {
    const pending = deferred<Settings>();
    api.invoke.mockImplementationOnce(async () => { await Promise.resolve(); return pending.promise; });
    const user = userEvent.setup();
    const view = render(<App />);
    expect(screen.getByRole("button", { name: "Настроить" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Сочетание клавиш" })).toBeDisabled();
    await act(async () => { pending.resolve(settings); await Promise.resolve(); });
    expect(await screen.findByText("Сочетание активно")).toBeVisible();
    expect(screen.getByRole("button", { name: "Настроить" })).toBeEnabled();
    await user.click(screen.getByRole("radio", { name: "Удержание" }));
    await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith("update_settings", { settings: { ...settings, triggerType: "hold" } }); });
    await user.click(screen.getByRole("button", { name: "Настроить" }));
    expect(api.invoke).toHaveBeenCalledWith("open_correction_settings");
    await user.click(screen.getByRole("button", { name: "Включить тёмную тему" }));
    expect(api.emit).toHaveBeenCalledWith("slovo://theme-changed", "dark");
    view.unmount();
    expect(disposers.length).toBeGreaterThan(0);
    for (const dispose of disposers) { expect(dispose).toHaveBeenCalledOnce(); }
  });

  it("routes status warnings, errors and settings events into the real view", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Сочетание активно");
    await act(async () => { emit("status", { elapsedSeconds: 12, kind: "recording" }); await Promise.resolve(); });
    expect(screen.getByText(/Слушаю/u)).toHaveTextContent("00:12");
    await act(async () => { emit("status", { correctionWarning: "offline", kind: "inserted" }); await Promise.resolve(); });
    expect(screen.getByRole("alert")).toHaveTextContent("Без корректировки: offline");
    await user.click(screen.getByRole("button", { name: "Скрыть" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { emit("status", { kind: "error", message: "Microphone unavailable" }); await Promise.resolve(); });
    expect(screen.getByRole("status", { name: "Ошибка — подробности в главном окне" })).toBeVisible();
    current = { ...settings, llmServerUrl: "https://example.com" };
    await act(async () => { emit("settings-changed", current); await Promise.resolve(); });
    expect(await screen.findByText("Включена")).toBeVisible();
  });

  it("captures a supported hotkey, retries one failed persistence, and clears the error", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Сочетание активно");
    await user.click(screen.getByRole("button", { name: "Сочетание клавиш" }));
    await act(async () => {
      globalThis.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyK", ctrlKey: true, key: "k" }));
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Сочетание клавиш" })).toHaveTextContent("Ctrl+K");
    rejectNextSettingsUpdate = true;
    await user.click(screen.getByRole("button", { name: "Сочетание клавиш" }));
    await act(async () => {
      globalThis.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyL", ctrlKey: true, key: "l" }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("settings update failed");
    await user.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => { expect(screen.queryByRole("alert")).not.toBeInTheDocument(); });
    expect(current.hotkey).toBe("Ctrl+KeyL");
    expect(screen.getByRole("button", { name: "Сочетание клавиш" })).toHaveTextContent("Ctrl+L");
  });

  it("opens permission setup, verifies, retries, and closes when setup becomes unavailable", async () => {
    const user = userEvent.setup();
    shortcutStatus = { setupAvailable: true, state: "permission-denied" };
    render(<App />);
    await screen.findByText(/Нет доступа к клавиатуре/u);
    await user.click(screen.getByRole("button", { name: "Настроить доступ…" }));
    await waitFor(() => { expect(screen.getByRole("heading", { name: "Доступ к клавиатуре" })).toBeVisible(); });
    await waitFor(() => { expect(screen.getByRole("checkbox")).toBeVisible(); });
    await user.click(screen.getByRole("checkbox"));
    await waitFor(() => { expect(screen.getByRole("button", { name: /снова/u })).toBeEnabled(); });
    await user.click(screen.getByRole("button", { name: /снова/u }));
    await waitFor(() => { expect(screen.queryByRole("heading", { name: "Доступ к клавиатуре" })).not.toBeInTheDocument(); });
    expect(api.invoke).toHaveBeenCalledWith("retry_shortcut_backend");
    const retries = api.invoke.mock.calls.filter(([command]) => command === "retry_shortcut_backend").length;
    expect(retries).toBe(1);
    await act(async () => { emit("shortcut-status", { setupAvailable: true, state: "permission-denied" }); await Promise.resolve(); });
    await user.click(screen.getByRole("button", { name: "Настроить доступ…" }));
    await waitFor(() => { expect(screen.getByRole("heading", { name: "Доступ к клавиатуре" })).toBeVisible(); });
    await act(async () => { emit("shortcut-status", { setupAvailable: false, state: "permission-denied" }); await Promise.resolve(); });
    await waitFor(() => { expect(screen.queryByRole("heading", { name: "Доступ к клавиатуре" })).not.toBeInTheDocument(); });
    expect(api.invoke.mock.calls.filter(([command]) => command === "retry_shortcut_backend").length).toBe(1);
  });

  it("reports open-window failure without offering an unrelated retry", async () => {
    render(<App />);
    await screen.findByText("Сочетание активно");
    api.invoke.mockRejectedValueOnce(new Error("denied"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Настроить" }));
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Повторить" })).not.toBeInTheDocument();
  });

  it("retries failed initial settings from the error banner", async () => {
    const invoke = api.invoke.getMockImplementation();
    let failed = false;
    api.invoke.mockImplementation((command: string, args?: { settings?: Partial<Settings> }) => {
      if (command === "get_settings" && !failed) { failed = true; throw new Error("Settings offline"); }
      const result: unknown = invoke?.(command, args);
      return result; 
    });
    render(<App />);
    expect(await screen.findByText("Settings offline")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => { expect(screen.getByRole("button", { name: "Настроить" })).toBeEnabled(); });
    expect(screen.getByRole("alert")).toHaveTextContent("Settings offline");
  });
});
