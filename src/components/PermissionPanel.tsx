import { Button } from "@/components/ui/button";
import type { JSX } from "react";
import { PermissionCommands } from "./PermissionCommands";
import { PermissionDisclosure } from "./PermissionDisclosure";
import type { ShortcutPermissionSetup } from "@/lib/types";
import { X } from "lucide-react";

interface PermissionPanelProps {
  readonly visible: boolean;
  readonly loading: boolean;
  readonly stateMessage: string;
  readonly setup: Readonly<
    Omit<ShortcutPermissionSetup, "installCommands" | "revokeCommands">
  > | null;
  readonly installCommands: readonly string[];
  readonly revokeCommands: readonly string[];
  readonly ackChecked: boolean;
  readonly copyInstallLabel: string;
  readonly copyRevokeLabel: string;
  readonly copyInstallDisabled: boolean;
  readonly copyRevokeDisabled: boolean;
  readonly verifyDisabled: boolean;
  readonly panelRef: React.RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onAckChange: (checked: boolean) => void;
  readonly onCopyInstall: () => void;
  readonly onCopyRevoke: () => void;
  readonly onVerify: () => void;
}

export function PermissionPanel({
  visible,
  loading,
  stateMessage,
  setup,
  installCommands,
  revokeCommands,
  ackChecked,
  copyInstallLabel,
  copyRevokeLabel,
  copyInstallDisabled,
  copyRevokeDisabled,
  verifyDisabled,
  panelRef,
  onClose,
  onAckChange,
  onCopyInstall,
  onCopyRevoke,
  onVerify,
}: PermissionPanelProps): JSX.Element | null {
  if (!visible) {
    return null;
  }

  const setupError = setup?.setupError?.trim() ?? "";
  const emptyLength = 0;
  const note = setup?.note?.trim() ?? "";
  let revokeNote = note;
  if (note === "") {
    revokeNote = "Эти команды вернут настройки доступа к устройствам ввода обратно.";
  }
  let setupLabel = "Доступ ещё не настроен.";
  if (setup?.installed === true) {
    setupLabel = "Доступ уже настроен. Если сочетание всё ещё не работает, проверьте его снова.";
  }

  return (
    <section
      ref={panelRef}
      aria-labelledby="permission-panel-title"
      className="rounded-lg border-l-[3px] border-l-destructive bg-muted/50 p-5 space-y-4"
    >
      <div className="flex items-center justify-between">
        <h2 id="permission-panel-title" className="text-base font-bold tracking-tight">
          Доступ к клавиатуре
        </h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Закрыть панель доступа к клавиатуре"
          className="h-7 w-7"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <p className="text-sm text-foreground">
        В Wayland нет обычного способа дать приложению глобальное сочетание клавиш. Поэтому для
        работы сочетания Слово нужен доступ текущего пользователя к потоку событий от клавиатуры.
      </p>

      <PermissionDisclosure />

      {stateMessage && (
        <output
          aria-live="polite"
          aria-atomic="true"
          className="block rounded-md bg-muted px-3 py-2 text-xs text-foreground"
        >
          {stateMessage}
        </output>
      )}

      {loading && (
        <output
          aria-live="polite"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <span>Загружаем инструкции…</span>
        </output>
      )}

      {setup && !loading && (
        <div className="space-y-4">
          {setupError && (
            <p
              role="alert"
              aria-live="assertive"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive"
            >
              {setupError}
            </p>
          )}

          <p className="text-sm font-semibold">{setupLabel}</p>

          <div className="rounded-md bg-destructive/10 p-3">
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={ackChecked}
                onChange={(event) => {
                  onAckChange(event.target.checked);
                }}
                className="mt-0.5 h-4 w-4 rounded accent-primary"
              />
              <span>Я понимаю, что доступ получат все процессы моего пользователя.</span>
            </label>
          </div>

          <PermissionCommands
            installCommands={installCommands}
            revokeCommands={revokeCommands}
            copyInstallLabel={copyInstallLabel}
            copyInstallDisabled={copyInstallDisabled}
            copyRevokeLabel={copyRevokeLabel}
            copyRevokeDisabled={copyRevokeDisabled}
            onCopyInstall={onCopyInstall}
            onCopyRevoke={onCopyRevoke}
            emptyLength={emptyLength}
            note={note}
            revokeNote={revokeNote}
          />
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="default" size="sm" onClick={onVerify} disabled={verifyDisabled}>
          Проверить снова
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>
          Закрыть
        </Button>
      </div>
    </section>
  );
}
