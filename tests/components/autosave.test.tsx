import { act, render, screen, waitFor } from "@testing-library/react";
import { deferred, settings } from "./helpers";
import { expect, it, vi } from "vitest";
import { App } from "../../src/App";
import userEvent from "@testing-library/user-event";

// Window sizing is tested separately; this check owns only visible save feedback.
vi.mock("../../src/hooks/useWindowAutoGrow", () => ({ useWindowAutoGrow: vi.fn() }));
const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: (): { label: string } => ({ label: "main" }),
}));

it("shows honest bootstrap guidance and visible saving/saved feedback", async () => {
  const load = deferred<typeof settings>();
  const save = deferred<typeof settings>();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  api.invoke.mockImplementation((command: string): unknown => {
    if (command === "get_settings") {
      return load.promise;
    }
    if (command === "update_settings") {
      return save.promise;
    }
    if (command === "get_shortcut_backend_status") {
      return { state: "active" };
    }
    if (command === "list_input_devices") {
      return [];
    }
    return null;
  });
  try {
    render(<App />);
    expect(screen.getByText("Настройки сохраняются автоматически")).toBeVisible();
    expect(screen.queryByText("Настройки сохранены")).not.toBeInTheDocument();
    await act(async () => {
      load.resolve(settings);
      await load.promise;
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Настроить" })).toBeEnabled();
    });
    expect(screen.queryByText("Настройки сохранены")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("radio", { name: "Удержание" }));
    expect(screen.getByText("Сохраняю настройки…")).toBeVisible();
    await act(async () => {
      save.resolve({ ...settings, triggerType: "hold" });
      await save.promise;
    });
    expect(screen.getByText("Настройки сохранены")).toBeVisible();
    expect(screen.getByText("Настройки сохранены")).not.toHaveClass("sr-only");
  } finally {
    vi.unstubAllGlobals();
  }
});
