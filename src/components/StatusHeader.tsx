import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/hooks/useTheme";
import type { StatusKind } from "@/lib/types";
import { cn } from "@/lib/utils";

/** "Слово" logo — a Cyrillic "С" formed by five voice-waveform bars.
 *  Bars use the indigo accent so they glow through the liquid-glass chip. */
function SlovoMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="slovo-mark relative z-10 h-5 w-5"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* The five bars double as the curve of a Cyrillic "С":
          heights taper at the ends, tallest in the middle, so their
          tops trace the letter's arc. Animate via scaleY from a shared
          transform-origin at the bottom of each bar. */}
      <rect
        className="slovo-bar slovo-bar-1"
        x="3"
        y="7"
        width="2.6"
        height="10"
        rx="1.3"
        fill="var(--accent-vivid)"
      />
      <rect
        className="slovo-bar slovo-bar-2"
        x="7"
        y="4"
        width="2.6"
        height="16"
        rx="1.3"
        fill="var(--accent-vivid)"
      />
      <rect
        className="slovo-bar slovo-bar-3"
        x="11"
        y="2.5"
        width="2.6"
        height="19"
        rx="1.3"
        fill="var(--accent-vivid)"
      />
      <rect
        className="slovo-bar slovo-bar-4"
        x="15"
        y="4"
        width="2.6"
        height="16"
        rx="1.3"
        fill="var(--accent-vivid)"
      />
      <rect
        className="slovo-bar slovo-bar-5"
        x="19"
        y="7"
        width="2.6"
        height="10"
        rx="1.3"
        fill="var(--accent-vivid)"
      />
    </svg>
  );
}

interface StatusHeaderProps {
  kind: StatusKind;
  text: string;
  theme: Theme;
  onToggleTheme: () => void;
}

/** High-visibility status pill — colored dot + bold text, distinct per state.
 *  Replaces the low-contrast shadcn Badge variants with a loud, legible chip. */
const statusStyle: Record<StatusKind, { dot: string; chip: string }> = {
  ready: {
    dot: "bg-zinc-400",
    chip: "bg-zinc-500/10  text-zinc-700 dark:text-zinc-200 border-zinc-500/25",
  },
  recording: {
    dot: "bg-red-500 animate-pulse",
    chip: "bg-red-500/15    text-red-700  dark:text-red-200  border-red-500/40",
  },
  transcribing: {
    dot: "bg-indigo-500 animate-pulse",
    chip: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-200 border-indigo-500/40",
  },
  inserted: {
    dot: "bg-emerald-500",
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-500/40",
  },
  copied: {
    dot: "bg-emerald-500",
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-500/40",
  },
  error: {
    dot: "bg-red-500",
    chip: "bg-red-500/15    text-red-700  dark:text-red-200  border-red-500/40",
  },
};

export function StatusHeader({
  kind,
  text,
  theme,
  onToggleTheme,
}: StatusHeaderProps) {
  const s = statusStyle[kind];
  return (
    <header className="flex items-center justify-between gap-4">
      <div className="relative isolate flex shrink-0 items-center gap-3">
        {/* Liquid bloom — soft luminous orbs that swell from the chip
            center and fade, like light spreading through liquid. Sits
            behind the glass chip + title. */}
        <div className="slovo-bloom" aria-hidden="true">
          <span className="slovo-orb slovo-orb-1" />
          <span className="slovo-orb slovo-orb-2" />
          <span className="slovo-orb slovo-orb-3" />
          <span className="slovo-orb slovo-orb-4" />
          <span className="slovo-orb slovo-orb-5" />
        </div>
        {/* Liquid-glass chip: frosted, refractive, with specular sheen
            and a chromatic edge (styled via .slovo-chip in index.css). */}
        <div className="slovo-chip flex h-9 w-9 items-center justify-center">
          <SlovoMark />
        </div>
        <h1 className="relative z-10 text-base font-bold tracking-tight">
          Слово
        </h1>
      </div>
      <div className="flex min-w-0 max-w-[60%] items-center gap-2">
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide backdrop-blur-sm",
            s.chip,
          )}
        >
          <span
            className={cn("h-1.5 w-1.5 rounded-full flex-shrink-0", s.dot)}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">{text}</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
          title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
        >
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </div>
    </header>
  );
}
