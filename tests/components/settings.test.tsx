import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ErrorBanner } from "../../src/components/ErrorBanner";
import { HotkeySetting } from "../../src/components/HotkeySetting";
import { PermissionPanel } from "../../src/components/PermissionPanel";
import { ServerUrlSetting } from "../../src/components/ServerUrlSetting";
import { StatusHeader } from "../../src/components/StatusHeader";
import { TriggerSetting } from "../../src/components/TriggerSetting";
import { createRef } from "react";
import userEvent from "@testing-library/user-event";

const windowApi = vi.hoisted(() => ({ close: vi.fn(), minimize: vi.fn() }));
vi.mock("@tauri-apps/api/window", (): { getCurrentWindow: () => typeof windowApi } => ({
  getCurrentWindow: () => windowApi,
}));

describe("settings public controls", () => {
  it("keeps focused server drafts, validates blur and schedules/checks valid edits", async () => {
    const user = userEvent.setup();
    const props = {
      availability: "available" as const,
      onBlurSave: vi.fn(),
      onCheckAvailability: vi.fn(),
      onInvalidateAvailability: vi.fn(),
      onScheduleSave: vi.fn(),
      value: "http://localhost",
    };
    const view = render(<ServerUrlSetting {...props} />);
    expect(screen.getByText("Соединение установлено")).toBeVisible();
    expect(screen.queryByText("Сервер доступен")).not.toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Сервер распознавания" });
    await user.clear(input);
    await user.type(input, "invalid");
    view.rerender(<ServerUrlSetting {...props} value="http://remote" />);
    expect(input).toHaveValue("invalid");
    await user.tab();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(props.onBlurSave).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "https://example.com");
    await user.tab();
    expect(props.onScheduleSave).toHaveBeenLastCalledWith("https://example.com");
    expect(props.onInvalidateAvailability).toHaveBeenCalled();
    expect(props.onBlurSave).toHaveBeenCalledWith("https://example.com");
    expect(props.onCheckAvailability).toHaveBeenCalledWith("https://example.com");
    expect(input).toHaveAttribute("aria-invalid", "false");
    view.rerender(<ServerUrlSetting {...props} value="http://new" availability="unavailable" />);
    expect(input).toHaveValue("http://new");
    expect(screen.getByText("Нет соединения")).toBeVisible();
  });

  it("routes trigger choices and reflects the controlled selection", async () => {
    const user = userEvent.setup();
    const change = vi.fn<(value: "hold" | "toggle" | "auto-vad") => void>();
    const view = render(<TriggerSetting value="toggle" onChange={change} />);
    expect(screen.getByRole("radio", { name: "Перекл." })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Удержание" }));
    expect(change).toHaveBeenCalledWith("hold");
    view.rerender(<TriggerSetting value="hold" onChange={change} />);
    expect(screen.getByRole("radio", { name: "Удержание" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Авто-VAD" }));
    expect(change).toHaveBeenLastCalledWith("auto-vad");
  });

  it("keeps keyboard focus on visible mode segments and explains recording limits", async () => {
    const user = userEvent.setup();
    const change = vi.fn<(value: "hold" | "toggle" | "auto-vad") => void>();
    const view = render(<TriggerSetting value="toggle" onChange={change} />);
    await user.tab();
    const toggle = screen.getByRole("radio", { name: "Перекл." });
    expect(toggle).toHaveFocus();
    expect(toggle.closest("label")).toHaveClass(
      "focus-within:outline-2",
      "focus-within:outline-ring",
    );
    expect(toggle.closest("label")).toHaveClass("bg-[var(--mode-selected)]", "text-white");
    await user.keyboard("{ArrowRight>}");
    await waitFor(() => {
      expect(change).toHaveBeenCalledWith("hold");
    });
    expect(screen.getByRole("radio", { name: "Удержание" })).toHaveFocus();
    await user.keyboard("{/ArrowRight}");
    view.rerender(<TriggerSetting value="auto-vad" onChange={change} />);
    expect(screen.getByText(/Запись остановится после паузы в речи/u)).toHaveTextContent(
      "До 2 минут за запись.",
    );
  });

  it("exposes capture, setup and retry actions while respecting busy controls", async () => {
    const user = userEvent.setup();
    const props = {
      captureMessage: null,
      hotkey: "Ctrl+Space",
      hotkeyDisabled: false,
      isCapturing: false,
      onHotkeyClick: vi.fn(),
      onRetry: vi.fn(),
      onSetup: vi.fn(),
      shortcutCanRetry: true,
      shortcutCanSetup: true,
      shortcutIsBusy: false,
      shortcutText: "Нет доступа",
      shortcutView: "warning" as const,
    };
    const view = render(<HotkeySetting {...props} />);
    await user.click(screen.getByRole("button", { name: "Сочетание клавиш" }));
    await user.click(screen.getByRole("button", { name: "Повторить" }));
    await user.click(screen.getByRole("button", { name: "Настроить доступ…" }));
    expect(props.onHotkeyClick).toHaveBeenCalledOnce();
    expect(props.onRetry).toHaveBeenCalledOnce();
    expect(props.onSetup).toHaveBeenCalledOnce();
    view.rerender(
      <HotkeySetting
        {...props}
        isCapturing
        captureMessage="Нажмите клавиши"
        hotkeyDisabled
        shortcutIsBusy
      />,
    );
    expect(screen.getByRole("button", { name: "Сочетание клавиш" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Сочетание клавиш" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeDisabled();
    expect(screen.getByText("Нажмите клавиши")).toBeVisible();
  });

  it("only offers an error retry when provided", async () => {
    const retry = vi.fn<() => void>();
    const view = render(<ErrorBanner message="" hasRetry onRetry={retry} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.rerender(<ErrorBanner message="Offline" hasRetry={false} onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Offline");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    view.rerender(<ErrorBanner message="Offline" hasRetry onRetry={retry} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Повторить" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("discloses permission scope, gates commands and forwards acknowledgement and verification", async () => {
    const user = userEvent.setup();
    const panelRef = createRef<HTMLElement>();
    const props = {
      ackChecked: false,
      copyInstallDisabled: true,
      copyInstallLabel: "Copy install",
      copyRevokeDisabled: false,
      copyRevokeLabel: "Copy revoke",
      installCommands: ["enable one", "enable two"],
      loading: false,
      onAckChange: vi.fn(),
      onClose: vi.fn(),
      onCopyInstall: vi.fn(),
      onCopyRevoke: vi.fn(),
      onVerify: vi.fn(),
      panelRef,
      revokeCommands: ["disable"],
      setup: { installed: false, setupError: "Permission denied" },
      stateMessage: "",
      verifyDisabled: true,
      visible: false,
    };
    const view = render(<PermissionPanel {...props} />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    view.rerender(<PermissionPanel {...props} visible loading />);
    expect(screen.getByText("Загружаем инструкции…")).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    view.rerender(<PermissionPanel {...props} visible />);
    expect(panelRef.current).toBe(screen.getByRole("region", { name: "Доступ к клавиатуре" }));
    expect(screen.getByText("весь сеанс пользователя")).toBeVisible();
    expect(screen.getByText("Permission denied")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy install" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Проверить снова" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(props.onAckChange).toHaveBeenCalledWith(true);
    view.rerender(
      <PermissionPanel
        {...props}
        visible
        ackChecked
        copyInstallDisabled={false}
        verifyDisabled={false}
        stateMessage="Copied"
      />,
    );
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText(/enable one/u)).toHaveTextContent("enable one enable two");
    await user.click(screen.getByRole("button", { name: "Copy install" }));
    await user.click(screen.getByRole("button", { name: "Copy revoke" }));
    await user.click(screen.getByRole("button", { name: "Проверить снова" }));
    await user.click(screen.getByRole("button", { name: "Закрыть панель доступа к клавиатуре" }));
    expect(props.onCopyInstall).toHaveBeenCalledOnce();
    expect(props.onCopyRevoke).toHaveBeenCalledOnce();
    expect(props.onVerify).toHaveBeenCalledOnce();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("routes titlebar actions and keeps the brand decorative", async () => {
    const user = userEvent.setup();
    const toggle = vi.fn<() => void>();
    const view = render(
      <StatusHeader kind="recording" text="Запись" theme="light" onToggleTheme={toggle} />,
    );
    expect(screen.getByText("Запись")).toBeVisible();
    expect(view.container.querySelector("svg.slovo-mark")).toHaveAttribute("aria-hidden", "true");
    await user.click(screen.getByRole("button", { name: "Включить тёмную тему" }));
    await user.click(screen.getByRole("button", { name: "Свернуть окно" }));
    await user.click(screen.getByRole("button", { name: "Закрыть окно" }));
    expect(toggle).toHaveBeenCalledOnce();
    expect(windowApi.minimize).toHaveBeenCalledOnce();
    expect(windowApi.close).toHaveBeenCalledOnce();
    view.rerender(
      <StatusHeader kind="correcting" text="Корректирую" theme="dark" onToggleTheme={toggle} />,
    );
    expect(screen.getByRole("button", { name: "Включить светлую тему" })).toBeEnabled();
  });
});
