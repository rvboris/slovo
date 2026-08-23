import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { displayPart, hotkeyParts } from "@/lib/hotkey";
import type { ShortcutViewState } from "@/lib/types";
import { cn } from "@/lib/utils";

interface HotkeySettingProps {
  hotkey: string;
  isCapturing: boolean;
  captureMessage: string | null;
  hotkeyDisabled: boolean;
  onHotkeyClick: () => void;
  shortcutView: ShortcutViewState;
  shortcutText: string;
  shortcutCanRetry: boolean;
  shortcutCanSetup: boolean;
  shortcutIsBusy: boolean;
  onRetry: () => void;
  onSetup: () => void;
}

const viewColor: Record<ShortcutViewState, string> = {
  idle: "bg-muted-foreground",
  preparing: "bg-muted-foreground animate-pulse",
  active: "bg-green-500",
  warning: "bg-yellow-500",
  error: "bg-destructive",
  neutral: "bg-muted-foreground opacity-50",
};

export function HotkeySetting({
  hotkey,
  isCapturing,
  captureMessage,
  hotkeyDisabled,
  onHotkeyClick,
  shortcutView,
  shortcutText,
  shortcutCanRetry,
  shortcutCanSetup,
  shortcutIsBusy,
  onRetry,
  onSetup,
}: HotkeySettingProps) {
  const parts = hotkeyParts(hotkey);

  return (
    <div className="space-y-2">
      <Label id="hotkey-label">Сочетание клавиш</Label>
      <button
        type="button"
        id="hotkey-control"
        aria-labelledby="hotkey-label"
        aria-pressed={isCapturing}
        onClick={onHotkeyClick}
        disabled={hotkeyDisabled}
        className={cn(
          "flex w-full min-h-[40px] flex-wrap items-center gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors cursor-pointer",
          "hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isCapturing && "border-ring bg-accent text-accent-foreground",
          hotkeyDisabled && "cursor-not-allowed opacity-50",
        )}
      >
        {captureMessage ? (
          <span
            className="font-semibold text-sm text-muted-foreground data-[capture]:text-accent-foreground/80"
            data-capture={isCapturing || undefined}
          >
            {captureMessage}
          </span>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1 font-semibold">
            {parts.map((part, i) => (
              <span key={part} className="inline-flex items-center gap-1">
                {i > 0 && (
                  <span
                    className="font-normal text-muted-foreground data-[capture]:text-accent-foreground/60"
                    data-capture={isCapturing || undefined}
                  >
                    +
                  </span>
                )}
                <kbd
                  className="inline-block rounded-sm border px-1.5 py-0.5 text-xs font-semibold border-border bg-muted data-[capture]:border-accent-foreground/25 data-[capture]:bg-accent-foreground/15 data-[capture]:text-accent-foreground"
                  data-capture={isCapturing || undefined}
                >
                  {displayPart(part)}
                </kbd>
              </span>
            ))}
          </span>
        )}
        <span
          className="ml-auto text-xs text-muted-foreground data-[capture]:text-accent-foreground/70 whitespace-nowrap"
          data-capture={isCapturing || undefined}
        >
          {isCapturing ? "Escape — отменить" : "Нажмите, чтобы изменить"}
        </span>
      </button>

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy={shortcutView === "preparing" ? "true" : "false"}
        className="flex items-center flex-wrap gap-2 text-xs text-muted-foreground"
      >
        <span
          className={cn(
            "h-2 w-2 rounded-full flex-shrink-0",
            viewColor[shortcutView],
          )}
          aria-hidden="true"
        />
        <span className="min-w-0 line-clamp-2 break-words">{shortcutText}</span>
        {shortcutCanRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={shortcutIsBusy}
            className="text-xs h-7 px-2"
          >
            Повторить
          </Button>
        )}
        {shortcutCanSetup && (
          <Button
            variant="outline"
            size="sm"
            onClick={onSetup}
            className="text-xs h-7 px-2"
          >
            Настроить доступ…
          </Button>
        )}
      </div>
    </div>
  );
}
