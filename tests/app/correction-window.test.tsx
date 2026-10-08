import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, settings } from "../components/helpers";
import { CorrectionWindow } from "../../src/CorrectionWindow";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted((): { close: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn>; listen: ReturnType<typeof vi.fn>; onCloseRequested: ReturnType<typeof vi.fn>; unsubscribe: ReturnType<typeof vi.fn>; unsubscribeClose: ReturnType<typeof vi.fn<() => void>> } => ({ close: vi.fn(), destroy: vi.fn(), invoke: vi.fn(), listen: vi.fn(), onCloseRequested: vi.fn(), unsubscribe: vi.fn(), unsubscribeClose: vi.fn<() => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));
vi.mock("@tauri-apps/api/window", (): { getCurrentWindow: () => typeof api } => ({ getCurrentWindow: (): typeof api => api }));
vi.mock("../../src/hooks/useTheme", () => ({ useTheme: vi.fn() }));
let closeRequest: (event: { preventDefault: () => void }) => Promise<void>;
let settingsChanged: () => void;
const listeners = new Map<string, (event: { payload: number }) => void>();
const unlistenSettings = vi.fn();
const unlistenExit = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  api.invoke.mockReset().mockImplementation(async (command: string): Promise<unknown> => {
    if (command === "get_settings" || command === "update_correction_settings") { return settings; }
    if (command === "correction_exit_ready") { return null; }
    await Promise.resolve();
    if (command === "get_settings") { return settings; }
    if (command === "update_correction_settings") { return settings; }
    if (command === "correction_exit_ready") { return null; }
    if (command === "resolve_exit_request") { return null; }
    throw new Error(`unexpected invoke ${command}`);
  });
  listeners.clear();
  api.listen.mockReset().mockImplementation(async (name: string, callback: (event: { payload: number }) => void): Promise<() => void> => { await Promise.resolve();
    if (name === "slovo://settings-changed") { settingsChanged = (): void => { callback({ payload: 0 }); }; listeners.set(name, callback); return (): void => { unlistenSettings(); }; }
    if (name === "slovo://exit-requested") { listeners.set(name, callback); return (): void => { unlistenExit(); }; }
    throw new Error(`unexpected event ${name}`);
  });
  api.onCloseRequested.mockReset().mockImplementation(async (callback: typeof closeRequest): Promise<() => void> => { await Promise.resolve(); closeRequest = callback; return api.unsubscribeClose; });
  api.destroy.mockReset().mockResolvedValue(null);
  api.close.mockReset().mockImplementation(async (): Promise<null> => { await closeRequest({ preventDefault: vi.fn<() => void>() }); return null; });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

describe("correction window", () => {
  it("delivers numeric exit requests after readiness and approves clean requests", async () => {
    const ready = vi.fn<() => Promise<null>>().mockResolvedValue(null);
    api.invoke.mockImplementation(async (command: string): Promise<unknown> => {
      await Promise.resolve();
      if (command === "correction_exit_ready") { return ready(); }
      if (command === "get_settings") { return settings; }
      if (command === "update_correction_settings" || command === "resolve_exit_request") { return null; }
      throw new Error(`unexpected invoke ${command}`);
    });
    render(<CorrectionWindow />);
    await waitFor(() => { expect(ready).toHaveBeenCalledTimes(1); });
    act(() => { listeners.get("slovo://exit-requested")?.({ payload: 73 }); });
    await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 73 }); });
    expect(ready).toHaveBeenCalled();
  });

  it("retries loading and unsubscribes both native listeners", async () => {
    let failedLoad = false;
    api.invoke.mockImplementation(async (command: string): Promise<unknown> => {
      await Promise.resolve();
      if (command === "correction_exit_ready") { return null; }
      if (command === "get_settings" && !failedLoad) { failedLoad = true; throw new Error("offline"); }
      if (command === "get_settings") { return settings; }
      return null;
    });
    const view = render(<CorrectionWindow />);
    expect(screen.getByRole("status")).toHaveTextContent("Загрузка настроек");
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось загрузить");
    await userEvent.setup().click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByLabelText("Адрес API")).toHaveValue("");
    view.unmount();
    expect(unlistenSettings).toHaveBeenCalledTimes(2);
    expect(unlistenExit).toHaveBeenCalledTimes(2);
    expect(api.unsubscribeClose).toHaveBeenCalledTimes(2);
  });

  it("preserves a draft on settings events, cancels dirty close, then destroys only after confirmation", async () => {
    const user = userEvent.setup();
    render(<CorrectionWindow />);
    await user.type(await screen.findByLabelText(/^Модель/u), "draft");
    api.invoke.mockResolvedValue({ ...settings, llmModel: "external" });
    await act(async () => { settingsChanged(); await Promise.resolve(); });
    expect(screen.getByLabelText(/^Модель/u)).toHaveValue("draft");
    await user.click(screen.getByRole("button", { name: "Закрыть окно" }));
    expect(screen.getByRole("alert")).toHaveFocus();
    expect(api.destroy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Продолжить редактирование" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Модель/u)).toHaveValue("draft");
    await user.click(screen.getByRole("button", { name: "Закрыть окно" }));
    await user.click(screen.getByRole("button", { name: "Закрыть без сохранения" }));
    expect(api.destroy).toHaveBeenCalledOnce();
  });

  it("blocks discard while saving, retries failed saves and closes cleanly after success", async () => {
    const user = userEvent.setup();
    render(<CorrectionWindow />);
    await user.type(await screen.findByLabelText(/^Модель/u), "draft");
    const pending = deferred<typeof settings>();
    api.invoke.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(api.invoke).toHaveBeenLastCalledWith("update_correction_settings", { correction: { llmApiKey: null, llmModel: "draft", llmPrompt: null, llmServerUrl: null } });
    await user.click(screen.getByRole("button", { name: "Закрыть окно" }));
    expect(screen.getByText("Дождитесь завершения сохранения.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Закрыть без сохранения" }));
    expect(api.destroy).not.toHaveBeenCalled();
    await act(async () => { pending.reject(new Error("offline")); await Promise.resolve(); });
    expect(screen.getByLabelText(/^Модель/u)).toHaveValue("draft");
    await user.click(screen.getByRole("button", { name: "Продолжить редактирование" }));
    api.invoke.mockResolvedValueOnce({ ...settings, llmModel: "draft" });
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByRole("button", { name: "Сохранено" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Закрыть окно" }));
    expect(api.destroy).toHaveBeenCalledOnce();
  });

  it("ignores a stale rejected settings load after a newer settings update", async () => {
    const older = deferred<typeof settings>();
    const newer = deferred<typeof settings>();
    api.invoke.mockReset().mockImplementation(async (command: string): Promise<unknown> => {
      await Promise.resolve();
      if (command === "get_settings") {
        if (api.invoke.mock.calls.filter(([called]) => called === command).length === 1) { return settings; }
        if (api.invoke.mock.calls.filter(([called]) => called === command).length === 2) { return older.promise; }
        return newer.promise;
      }
      if (command === "correction_exit_ready") { return null; }
      return null;
    });
    render(<CorrectionWindow />);
    await screen.findByLabelText("Адрес API");
    await act(async () => { settingsChanged(); settingsChanged(); await Promise.resolve(); });
    await act(async () => {
      newer.resolve({ ...settings, llmModel: "new-model" });
      await newer.promise;
    });
    await act(async () => {
      older.reject(new Error("stale failure"));
      await expect(older.promise).rejects.toThrow("stale failure");
    });
    expect(screen.getByLabelText(/^Модель/u)).toHaveValue("new-model");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports native close failure instead of silently losing the window", async () => {
    render(<CorrectionWindow />);
    await screen.findByLabelText("Адрес API");
    api.destroy.mockRejectedValueOnce(new Error("denied"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Закрыть окно" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Не удалось закрыть окно");
  });

  it("cleans up a late close-request registration after unmount", async () => {
    const pending = deferred<() => void>();
    api.onCloseRequested.mockImplementationOnce(async (): Promise<() => void> => { await Promise.resolve(); return pending.promise; });
    const view = render(<CorrectionWindow />);
    await waitFor(() => { expect(api.onCloseRequested).toHaveBeenCalledOnce(); });
    view.unmount();
    await act(async () => { pending.resolve(api.unsubscribeClose); await Promise.resolve(); });
    await waitFor(() => { expect(api.unsubscribeClose).toHaveBeenCalledOnce(); });
    expect(api.destroy).not.toHaveBeenCalled();
  });

  it("recovers from native registration failure without destroying the window", async () => {
    api.listen.mockRejectedValueOnce(new Error("listen failed"));
    render(<CorrectionWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось подключить события окна");
    expect(api.destroy).not.toHaveBeenCalled();
  });

  it("retains dirty drafts when discard fails and retries successfully", async () => {
    api.destroy.mockReset().mockResolvedValue(null);
    const user = userEvent.setup();
    render(<CorrectionWindow />);
    const model = await screen.findByLabelText(/^Модель/u);
    await user.clear(model);
    await user.type(model, "draft");
    await user.click(screen.getByRole("button", { name: "Закрыть окно" }));
    api.destroy.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Закрыть без сохранения" }));
    expect(screen.getByLabelText(/^Модель/u)).toHaveValue("draft");
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Не удалось закрыть окно");
    api.destroy.mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: "Закрыть без сохранения" }));
    expect(api.destroy).toHaveBeenCalledTimes(2);
  });

  it("releases a subscription that resolves after unmount", async () => {
    const pending = deferred<() => void>();
    api.listen.mockReturnValueOnce(pending.promise);
    const view = render(<CorrectionWindow />);
    view.unmount();
    await act(async () => { pending.resolve(() => { api.unsubscribe(); }); await Promise.resolve(); });
    await waitFor(() => { expect(api.unsubscribe).toHaveBeenCalledOnce(); });
    expect(api.onCloseRequested).not.toHaveBeenCalled();
    expect(api.invoke).not.toHaveBeenCalled();
  });
});
