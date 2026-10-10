import { displayPart, hotkeyParts } from "@/lib/hotkey";
import { Button } from "@/components/ui/button";
import type { JSX } from "react";
import { Label } from "@/components/ui/label";
import type { ShortcutViewState } from "@/lib/types";
import { cn } from "@/lib/utils";

interface HotkeySettingProps {
  readonly hotkey: string;
  readonly isCapturing: boolean;
  readonly captureMessage: string | null;
  readonly hotkeyDisabled: boolean;
  readonly onHotkeyClick: () => void;
  readonly shortcutView: ShortcutViewState;
  readonly shortcutText: string;
  readonly shortcutCanRetry: boolean;
  readonly shortcutCanSetup: boolean;
  readonly shortcutIsBusy: boolean;
  readonly onRetry: () => void;
  readonly onSetup: () => void;
}

const viewColor: Record<ShortcutViewState, string> = {
  active: "bg-green-500",
  error: "bg-destructive",
  idle: "bg-muted-foreground",
  neutral: "bg-muted-foreground opacity-50",
  preparing: "bg-muted-foreground animate-pulse",
  warning: "bg-yellow-500",
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
}: HotkeySettingProps): JSX.Element | null {
  const parts = hotkeyParts(hotkey);
  const firstPartIndex = 0;
  let captureHint = "Нажмите, чтобы изменить";
  if (isCapturing) {
    captureHint = "Escape — отменить";
  }

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
          "flex w-full h-9 min-h-[36px] flex-wrap items-center gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors cursor-pointer",
          "hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isCapturing && "border-ring bg-accent text-accent-foreground",
          hotkeyDisabled && "cursor-not-allowed opacity-50",
        )}
      >
        {Boolean(captureMessage) && (
          <span
            className="font-semibold text-sm text-muted-foreground data-[capture]:text-accent-foreground/80"
            data-capture={isCapturing || undefined}
          >
            {captureMessage}
          </span>
        )}
        {(captureMessage === null || captureMessage === "") && (
          <span className="inline-flex flex-wrap items-center gap-1 font-semibold">
            {parts.map((part, index) => (
              <span key={part} className="inline-flex items-center gap-1">
                {index > firstPartIndex && (
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
          {captureHint}
        </span>
      </button>

      <output
        aria-live="polite"
        aria-atomic="true"
        aria-busy={shortcutView === "preparing"}
        className="flex items-center flex-wrap gap-2 text-xs text-muted-foreground"
      >
        <span
          className={cn("h-2 w-2 rounded-full flex-shrink-0", viewColor[shortcutView])}
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
          <Button variant="outline" size="sm" onClick={onSetup} className="text-xs h-7 px-2">
            Настроить доступ…
          </Button>
        )}
      </output>
    </div>
  );
}
