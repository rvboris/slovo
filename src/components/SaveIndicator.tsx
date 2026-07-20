import type { SaveKind } from "@/lib/types";
import { cn } from "@/lib/utils";

interface SaveIndicatorProps {
  text: string;
  kind: SaveKind;
}

const dotColor: Record<SaveKind, string> = {
  idle: "bg-muted-foreground opacity-50",
  saving: "bg-primary animate-pulse",
  saved: "bg-primary",
  error: "bg-destructive",
};

export function SaveIndicator({ text, kind }: SaveIndicatorProps) {
  return (
    <footer className="flex items-center justify-center mt-auto pt-4" data-save-kind={kind}>
      <span className="inline-flex items-center gap-[7px] text-xs text-muted-foreground font-medium">
        <span
          className={cn("h-1.5 w-1.5 rounded-full transition-colors", dotColor[kind])}
          aria-hidden="true"
        />
        <span className={kind === "saved" ? "opacity-60" : ""}>
          {text}
          {kind === "saving" && "…"}
        </span>
      </span>
    </footer>
  );
}
