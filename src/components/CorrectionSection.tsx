import { Button } from "@/components/ui/button";
import type { JSX } from "react";

export function CorrectionSection({ correctionLabel, correctionTone, disabled, onOpen }: Readonly<{
  correctionLabel: string;
  correctionTone: string;
  disabled: boolean;
  onOpen: () => void;
}>): JSX.Element {
  return (
    <section className="flex items-center justify-between gap-4 border-t border-border pt-4">
      <div>
        <h2 className="text-sm font-semibold">Корректировка текста</h2>
        <p className={`mt-1 text-xs text-medium ${correctionTone}`}>{correctionLabel}</p>
      </div>
      <Button size="sm" variant="outline" disabled={disabled} onClick={onOpen}>Настроить</Button>
    </section>
  );
}
