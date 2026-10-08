import { Button } from "@/components/ui/button";
import type { JSX } from "react";

interface PermissionCommandsProps {
  readonly installCommands: readonly string[];
  readonly revokeCommands: readonly string[];
  readonly copyInstallLabel: string;
  readonly copyInstallDisabled: boolean;
  readonly copyRevokeLabel: string;
  readonly copyRevokeDisabled: boolean;
  readonly onCopyInstall: () => void;
  readonly onCopyRevoke: () => void;
  readonly emptyLength: number;
  readonly note: string;
  readonly revokeNote: string;
}
export function PermissionCommands({ installCommands, revokeCommands, copyInstallLabel, copyInstallDisabled, copyRevokeLabel, copyRevokeDisabled, onCopyInstall, onCopyRevoke, emptyLength, note, revokeNote }: PermissionCommandsProps): JSX.Element {
 return <>
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
            {installCommands.length > emptyLength && (
              <pre className="block rounded-md bg-muted p-3 overflow-x-auto text-sm leading-relaxed">
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
            {(note !== "" || revokeCommands.length > emptyLength) && (
              <p className="text-xs text-muted-foreground">
                {revokeNote}
              </p>
            )}
            {revokeCommands.length > emptyLength && (
              <pre className="block rounded-md bg-muted p-3 overflow-x-auto text-sm leading-relaxed">
                <code className="font-mono">{revokeCommands.join("\n")}</code>
              </pre>
            )}
          </div>
 </>;
}
