import type { SaveKind } from "@/lib/types";
import { cn } from "@/lib/utils";

interface SaveIndicatorProps {
  text: string;
  kind: SaveKind;
}

const dotColor: Record<SaveKind, string> = {
  idle: "bg-muted-foreground/70",
  saving: "bg-primary animate-pulse",
  saved: "bg-primary",
  error: "bg-destructive",
};

const indicatorStyle: Record<SaveKind, string> = {
  idle: "text-muted-foreground",
  saving: "border-primary/20 bg-primary/5 text-foreground",
  saved: "text-foreground",
  error: "border-destructive/20 bg-destructive/10 text-destructive",
};

export function SaveIndicator({ text, kind }: SaveIndicatorProps) {
  if (kind === "idle") return null;

  return (
    <footer className="mt-auto flex shrink-0 items-center justify-center" data-save-kind={kind}>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={cn(
          "inline-flex min-h-8 items-center gap-2 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-medium shadow-sm transition-colors",
          indicatorStyle[kind],
        )}
      >
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full transition-colors", dotColor[kind])}
          aria-hidden="true"
        />
        <span>
          {text}
          {kind === "saving" && "…"}
        </span>
      </span>
    </footer>
  );
}
