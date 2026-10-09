import { Minus, Moon, Sun, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { JSX } from "react";
import { SlovoMark } from "./SlovoMark";
import type { StatusKind } from "@/lib/types";
import type { Theme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface StatusHeaderProps {
  readonly kind: StatusKind;
  readonly text: string;
  readonly theme: Theme;
  readonly onToggleTheme: () => void;
}

const statusStyle: Record<StatusKind, { dot: string; chip: string }> = {
  copied: { chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  correcting: { chip: "bg-violet-500/10 text-violet-700 dark:text-violet-300", dot: "bg-violet-500" },
  error: { chip: "bg-destructive/10 text-destructive", dot: "bg-destructive" },
  inserted: { chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  ready: { chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  recording: { chip: "bg-destructive/10 text-destructive", dot: "bg-destructive" },
  transcribing: { chip: "bg-amber-500/10 text-amber-700 dark:text-amber-300", dot: "bg-amber-500" },
};

export function StatusHeader({ kind, text, theme, onToggleTheme }: StatusHeaderProps) : JSX.Element | null {
  const style = statusStyle[kind];
  const window = getCurrentWindow();

  let themeLabel = "Включить тёмную тему";
  let themeIcon = <Moon className="h-4 w-4" />;
  if (theme === "dark") { themeLabel = "Включить светлую тему"; themeIcon = <Sun className="h-4 w-4" />; }
  return (
    <header className="titlebar flex h-10 shrink-0 items-center border-b border-border/80 bg-background/95 pl-6 backdrop-blur-md">
      <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-3">
        <div className="relative isolate flex shrink-0 items-center gap-2">
          <div className="slovo-bloom" aria-hidden="true" />
          <div className="slovo-chip flex h-7 w-7 items-center justify-center">
            <SlovoMark />
          </div>
          <span className="text-sm font-semibold tracking-[-0.02em]">Слово</span>
        </div>
      </div>

      <div className="flex h-full shrink-0 items-center gap-1 pr-1">
        <output aria-live="polite" title={text} className={cn("flex max-w-40 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold", style.chip)}>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} aria-hidden="true" />
          <span className="truncate">{text}</span>
        </output>
        <Button variant="ghost" size="icon" onClick={onToggleTheme} className="h-8 w-8" aria-label={themeLabel}>
          {themeIcon}
        </Button>
        <button type="button" onClick={() => { void window.minimize(); }} className="titlebar-control" aria-label="Свернуть окно">
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" onClick={() => { void window.close(); }} className="titlebar-control titlebar-close" aria-label="Закрыть окно">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
