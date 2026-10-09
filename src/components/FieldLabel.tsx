import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CircleHelp } from "lucide-react";
import type { JSX } from "react";
import { Label } from "@/components/ui/label";

export function FieldLabel({ htmlFor, label, mark = "", hint }: Readonly<{ htmlFor: string; label: string; mark?: string; hint: string }>): JSX.Element {
  return (
    <div className="flex items-center gap-1">
      <Label htmlFor={htmlFor}>{label}{mark}</Label>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={`Подсказка: ${label}`} className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </div>
  );
}
