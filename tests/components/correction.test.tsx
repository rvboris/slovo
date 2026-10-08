import { act, render, screen } from "@testing-library/react";
import { deferred, settings } from "./helpers";
import { describe, expect, it, vi } from "vitest";
import { CorrectionSetting } from "../../src/components/CorrectionSetting";
import userEvent from "@testing-library/user-event";

describe("CorrectionSetting", () => {
  it("provides a full-width six-row prompt while preserving multiline editing and locks", async () => {
    const user = userEvent.setup();
    const save = vi.fn<() => Promise<void>>().mockResolvedValue();
    const view = render(<CorrectionSetting settings={settings} onSave={save} />);
    const prompt = screen.getByLabelText(/^Инструкция/u);
    expect(prompt).toHaveAttribute("rows", "6");
    expect(prompt).toHaveClass("block", "w-full", "resize-y", "border", "border-input", "px-3", "py-2", "focus-visible:ring-2", "disabled:opacity-50");
    await user.type(prompt, "Первая строка{Enter}Вторая строка");
    expect(prompt).toHaveValue("Первая строка\nВторая строка");
    view.rerender(<CorrectionSetting settings={settings} onSave={save} locked />);
    expect(prompt).toBeDisabled();
    expect(prompt).toHaveValue("Первая строка\nВторая строка");
  });
  it("validates URL and required fields without submitting secrets", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<CorrectionSetting settings={settings} onSave={save} />);
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeDisabled();
    const url = screen.getByLabelText(/^Адрес API/u);
    await user.type(url, "https://user:secret@example.com");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(screen.getByRole("alert")).toHaveTextContent("без логина и пароля");
    await user.clear(url);
    await user.type(url, "https://example.com/v1");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(screen.getByRole("alert")).toHaveTextContent("модель и инструкцию");
    expect(save).not.toHaveBeenCalled();
  });

  it("preserves dirty drafts across external updates and failed saves, then retries normalized values", async () => {
    const user = userEvent.setup();
    const pending = deferred<undefined>();

    const save = vi.fn<() => Promise<void>>().mockReturnValueOnce(pending.promise).mockResolvedValue();
    const dirty = vi.fn<(dirty: boolean) => void>();
    const view = render(<CorrectionSetting settings={settings} onSave={save} onDirtyChange={dirty} />);
    await user.type(screen.getByLabelText(/^Адрес API/u), "https://example.com/v1");
    await user.type(screen.getByLabelText(/^Модель/u), " model ");
    await user.type(screen.getByLabelText(/^Инструкция/u), " fix text ");
    await user.type(screen.getByLabelText(/^API-ключ/u), " secret ");
    view.rerender(<CorrectionSetting settings={{ ...settings, llmModel: "external" }} onSave={save} onDirtyChange={dirty} />);
    expect(screen.getByLabelText(/^Модель/u)).toHaveValue(" model ");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(screen.getByRole("button", { name: "Сохраняю…" })).toBeDisabled();
    expect(screen.getByLabelText(/^Адрес API/u)).toBeDisabled();
    await act(async () => { pending.reject(new Error("offline")); await expect(pending.promise).rejects.toThrow("offline"); });
    expect(screen.getByRole("alert")).toHaveTextContent("Введённые данные сохранены");
    expect(screen.getByLabelText(/^API-ключ/u)).toHaveValue(" secret ");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(save).toHaveBeenLastCalledWith({ llmApiKey: "secret", llmModel: "model", llmPrompt: "fix text", llmServerUrl: "https://example.com/v1" });
    expect(await screen.findByRole("button", { name: "Сохранено" })).toBeDisabled();
    expect(dirty).toHaveBeenLastCalledWith(false);
    view.rerender(<CorrectionSetting settings={{ ...settings, llmModel: "remote" }} onSave={save} />);
    expect(screen.getByLabelText(/^Модель/u)).toHaveValue("remote");
  });

  it("allows disabling correction with a blank URL and no required model", async () => {
    const user = userEvent.setup();
    const save = vi.fn<() => Promise<void>>().mockResolvedValue();
    render(<CorrectionSetting settings={{ ...settings, llmServerUrl: "https://example.com" }} onSave={save} />);
    await user.clear(screen.getByLabelText(/^Адрес API/u));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(save).toHaveBeenCalledWith({ llmApiKey: null, llmModel: null, llmPrompt: null, llmServerUrl: null });
  });
});
