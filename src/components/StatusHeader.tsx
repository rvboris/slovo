import { Button } from "@/components/ui/button";
import { Minus, Moon, Sun, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { StatusKind } from "@/lib/types";
import type { Theme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

function SlovoMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="slovo-mark relative z-10 h-5 w-5"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="slovo-bar slovo-bar-1" x="3" y="7" width="2.6" height="10" rx="1.3" fill="var(--accent-vivid)" />
      <rect className="slovo-bar slovo-bar-2" x="7" y="4" width="2.6" height="16" rx="1.3" fill="var(--accent-vivid)" />
      <rect className="slovo-bar slovo-bar-3" x="11" y="2.5" width="2.6" height="19" rx="1.3" fill="var(--accent-vivid)" />
      <rect className="slovo-bar slovo-bar-4" x="15" y="4" width="2.6" height="16" rx="1.3" fill="var(--accent-vivid)" />
      <rect className="slovo-bar slovo-bar-5" x="19" y="7" width="2.6" height="10" rx="1.3" fill="var(--accent-vivid)" />
    </svg>
  );
}

interface StatusHeaderProps {
  kind: StatusKind;
  text: string;
  theme: Theme;
  onToggleTheme: () => void;
}

const statusStyle: Record<StatusKind, { dot: string; chip: string }> = {
  ready: { dot: "bg-emerald-500", chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  recording: { dot: "bg-destructive", chip: "bg-destructive/10 text-destructive" },
  transcribing: { dot: "bg-amber-500", chip: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  inserted: { dot: "bg-emerald-500", chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  copied: { dot: "bg-emerald-500", chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  error: { dot: "bg-destructive", chip: "bg-destructive/10 text-destructive" },
};

export function StatusHeader({ kind, text, theme, onToggleTheme }: StatusHeaderProps) {
  const s = statusStyle[kind];
  const window = getCurrentWindow();

  return (
    <header className="titlebar flex h-10 items-center border-b border-border/80 bg-background/95 pl-4 backdrop-blur-md">
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
        <div className={cn("flex max-w-40 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold", s.chip)}>
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} aria-hidden="true" />
          <span className="truncate">{text}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onToggleTheme} className="h-8 w-8" aria-label={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"}>
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <button type="button" onClick={() => void window.minimize()} className="titlebar-control" aria-label="Свернуть окно">
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>
        <button type="button" onClick={() => void window.close()} className="titlebar-control titlebar-close" aria-label="Закрыть окно">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
