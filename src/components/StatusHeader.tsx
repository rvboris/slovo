import { Badge } from "@/components/ui/badge";
import { Mic } from "lucide-react";
import type { StatusKind } from "@/lib/types";

interface StatusHeaderProps {
  kind: StatusKind;
  text: string;
}

const badgeVariant: Record<StatusKind, "default" | "secondary" | "destructive" | "outline"> = {
  ready: "secondary",
  recording: "destructive",
  transcribing: "default",
  inserted: "default",
  copied: "default",
  error: "destructive",
};

export function StatusHeader({ kind, text }: StatusHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4">
      <div className="flex shrink-0 items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Mic className="h-5 w-5" />
        </div>
        <h1 className="text-base font-bold tracking-tight">Слово</h1>
      </div>
      <div className="min-w-0 max-w-[60%]" role="status" aria-live="polite" aria-atomic="true">
        <Badge
          variant={badgeVariant[kind]}
          className={
            kind === "recording"
              ? "max-w-full truncate animate-pulse"
              : kind === "transcribing"
                ? "max-w-full truncate animate-pulse"
                : "max-w-full truncate"
          }
        >
          {text}
        </Badge>
      </div>
    </header>
  );
}
