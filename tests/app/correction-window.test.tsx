import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, settings } from "../components/helpers";
import type { JSX } from "react";
import { useCorrectionScreen } from "../../src/hooks/use-correction-screen";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";

function CorrectionWindow(): JSX.Element {
  const { content, notices, open } = useCorrectionScreen();
  useEffect(() => { void open(); }, [open]);
  return <>{notices}{content ?? <p>Главный экран</p>}</>;
}

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

  it("retries loading and unsubscribes settings and exit listeners", async () => {
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
    expect(api.onCloseRequested).not.toHaveBeenCalled();
  });

  it("preserves a draft on settings events, stays on dirty Back, then discards on confirmation", async () => {
    const user = userEvent.setup();
    render(<CorrectionWindow />);
    await user.type(await screen.findByLabelText(/^Модель/u), "draft");
    api.invoke.mockResolvedValue({ ...settings, llmModel: "external" });
    await act(async () => { settingsChanged(); await Promise.resolve(); });
    expect(screen.getByLabelText(/^Модель/u)).toHaveValue("draft");
    await user.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.getByRole("alert")).toHaveFocus();
    expect(api.destroy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Продолжить редактирование" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Модель/u)).toHaveValue("draft");
    await user.click(screen.getByRole("button", { name: "Отмена" }));
    await user.click(screen.getByRole("button", { name: "Отбросить изменения" }));
    expect(screen.getByText("Главный экран")).toBeInTheDocument();
  });

  it("blocks discard while saving, retries failed saves and closes cleanly after success", async () => {
    const user = userEvent.setup();
    render(<CorrectionWindow />);
    await user.type(await screen.findByLabelText(/^Модель/u), "draft");
    const pending = deferred<typeof settings>();
    api.invoke.mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(api.invoke).toHaveBeenLastCalledWith("update_correction_settings", { correction: { llmApiKey: null, llmModel: "draft", llmPrompt: null, llmServerUrl: null } });
    await user.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
    expect(api.destroy).not.toHaveBeenCalled();
    await act(async () => { pending.reject(new Error("offline")); await Promise.resolve(); });
    expect(screen.getByLabelText(/^Модель/u)).toHaveValue("draft");
    api.invoke.mockResolvedValueOnce({ ...settings, llmModel: "draft" });
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Главный экран")).toBeInTheDocument();
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


});

it("returns without edits and keeps the exit handshake alive on the main screen", async () => {
  const user = userEvent.setup();
  render(<CorrectionWindow />);
  await screen.findByLabelText(/^Модель/u);
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith("correction_exit_ready"); });
  await user.click(screen.getByRole("button", { name: "Отмена" }));
  expect(screen.getByText("Главный экран")).toBeInTheDocument();
  act(() => { listeners.get("slovo://exit-requested")?.({ payload: 81 }); });
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 81 }); });
  expect(api.onCloseRequested).not.toHaveBeenCalled();
  expect(api.destroy).not.toHaveBeenCalled();
});

it("saves from the dirty Back notice and returns to main", async () => {
  const user = userEvent.setup();
  render(<CorrectionWindow />);
  await user.type(await screen.findByLabelText(/^Модель/u), "draft");
  await user.click(screen.getByRole("button", { name: "Отмена" }));
  await user.click(screen.getByRole("button", { name: "Сохранить и вернуться" }));
  expect(await screen.findByText("Главный экран")).toBeInTheDocument();
});

it("prioritizes an exit arriving during save over returning to main", async () => {
  const user = userEvent.setup();
  render(<CorrectionWindow />);
  await user.type(await screen.findByLabelText(/^Модель/u), "draft");
  const pending = deferred<typeof settings>();
  api.invoke.mockImplementation(async (command: string): Promise<unknown> => {
    await Promise.resolve();
    if (command === "update_correction_settings") { return pending.promise; }
    return null;
  });
  await user.click(screen.getByRole("button", { name: "Сохранить" }));
  act(() => { listeners.get("slovo://exit-requested")?.({ payload: 82 }); });
  expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Выйти без сохранения" })).toBeDisabled();
  await act(async () => { pending.resolve({ ...settings, llmModel: "draft" }); await pending.promise; });
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 82 }); });
  expect(screen.queryByText("Главный экран")).not.toBeInTheDocument();
  expect(screen.getByLabelText(/^Модель/u)).toHaveValue("draft");
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

it("reconnects failed exit registration before announcing readiness", async () => {
  const user = userEvent.setup();
  api.listen.mockRejectedValueOnce(new Error("offline"));
  render(<CorrectionWindow />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось подключить события окна");
  expect(api.invoke).not.toHaveBeenCalledWith("correction_exit_ready");
  await user.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith("correction_exit_ready"); });
  expect(listeners.has("slovo://exit-requested")).toBe(true);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
