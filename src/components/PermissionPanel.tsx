import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { type ShortcutPermissionSetup } from "@/lib/types";

interface PermissionPanelProps {
  visible: boolean;
  loading: boolean;
  stateMessage: string;
  setup: ShortcutPermissionSetup | null;
  installCommands: string[];
  revokeCommands: string[];
  ackChecked: boolean;
  copyInstallLabel: string;
  copyRevokeLabel: string;
  copyInstallDisabled: boolean;
  copyRevokeDisabled: boolean;
  verifyDisabled: boolean;
  panelRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onAckChange: (checked: boolean) => void;
  onCopyInstall: () => void;
  onCopyRevoke: () => void;
  onVerify: () => void;
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
}: PermissionPanelProps) {
  if (!visible) return null;

  const setupError = setup?.setupError?.trim();

  return (
    <section
      ref={panelRef as React.RefObject<HTMLElement>}
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
        В Wayland нет обычного способа дать приложению глобальное сочетание
        клавиш. Поэтому для работы сочетания Слово нужен доступ текущего
        пользователя к потоку событий от клавиатуры.
      </p>

      <ul className="space-y-2 text-xs text-muted-foreground">
        <li className="flex gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-destructive flex-shrink-0" />
          <span>
            Доступ получает <strong className="text-foreground font-semibold">весь сеанс пользователя</strong>,
            а не только Слово. Любая программа, запущенная от вашего имени,
            сможет читать все нажатия клавиш.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-destructive flex-shrink-0" />
          <span>
            Сам помощник Слово фильтрует события локально и передаёт наружу
            только нажатия и отпускания назначенного сочетания. Но это не
            защищает от других программ того же пользователя.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-destructive flex-shrink-0" />
          <span>
            Команды ниже выполняются только вами — никаких скрытых повышений
            прав. Скопируйте их в терминал и запустите самостоятельно.
          </span>
        </li>
      </ul>

      {stateMessage && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="rounded-md bg-muted px-3 py-2 text-xs text-foreground"
        >
          {stateMessage}
        </div>
      )}

      {loading && (
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          <span>Загружаем инструкции…</span>
        </div>
      )}

      {setup && !loading && (
        <div className="space-y-4">
          {setupError && (
            <p role="alert" aria-live="assertive" className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive">
              {setupError}
            </p>
          )}

          <p className="text-sm font-semibold">
            {setup.installed
              ? "Доступ уже настроен. Если сочетание всё ещё не работает, проверьте его снова."
              : "Доступ ещё не настроен."}
          </p>

          <div className="rounded-md bg-destructive/10 p-3">
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={ackChecked}
                onChange={(e) => onAckChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded accent-primary"
              />
              <span>
                Я понимаю, что доступ получат все процессы моего пользователя.
              </span>
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Команды для включения</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={onCopyInstall}
                disabled={copyInstallDisabled}
                className="text-xs h-7"
              >
                {copyInstallLabel}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Запустите эти команды в терминале от своего пользователя, затем
              вернитесь и нажмите «Проверить снова».
            </p>
            {installCommands.length > 0 && (
              <pre className="rounded-md bg-muted p-3 overflow-x-auto text-sm leading-relaxed">
                <code className="font-mono">{installCommands.join("\n")}</code>
              </pre>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Команды для отключения</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={onCopyRevoke}
                disabled={copyRevokeDisabled}
                className="text-xs h-7"
              >
                {copyRevokeLabel}
              </Button>
            </div>
            {(setup.note?.trim() || revokeCommands.length > 0) && (
              <p className="text-xs text-muted-foreground">
                {setup.note?.trim() ||
                  "Эти команды вернут настройки доступа к устройствам ввода обратно."}
              </p>
            )}
            {revokeCommands.length > 0 && (
              <pre className="rounded-md bg-muted p-3 overflow-x-auto text-sm leading-relaxed">
                <code className="font-mono">{revokeCommands.join("\n")}</code>
              </pre>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          variant="default"
          size="sm"
          onClick={onVerify}
          disabled={verifyDisabled}
        >
          Проверить снова
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>
          Закрыть
        </Button>
      </div>
    </section>
  );
}
