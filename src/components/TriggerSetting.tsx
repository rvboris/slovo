import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { JSX } from "react";
import { Label } from "@/components/ui/label";
import type { TriggerType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { triggerDescriptions } from "@/lib/types";

interface TriggerSettingProps {
  readonly value: TriggerType;
  readonly onChange: (value: TriggerType) => void;
}

const options: readonly { readonly value: TriggerType; readonly label: string }[] = [
  { label: "Перекл.", value: "toggle" },
  { label: "Удержание", value: "hold" },
  { label: "Авто-VAD", value: "auto-vad" },
];

export function TriggerSetting({ value, onChange }: TriggerSettingProps): JSX.Element | null {
  let description = triggerDescriptions[value];
  if (value === "auto-vad") {
    description = "Нажмите сочетание, чтобы начать. Запись остановится после паузы в речи.";
  }
  return (
    <div className="space-y-2">
      <Label>Запуск записи</Label>
      <RadioGroup
        value={value}
        onValueChange={(next) => {
          if (next === "toggle" || next === "hold" || next === "auto-vad") {
            onChange(next);
          }
        }}
        className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1"
        aria-label="Тип срабатывания"
      >
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <label
              key={opt.value}
              className={cn(
                "relative flex items-center justify-center rounded-lg px-3 py-2 text-sm font-bold cursor-pointer transition-all duration-200 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring",
                active &&
                  "bg-[var(--mode-selected)] text-white shadow-[0_4px_14px_oklch(0.55_0.22_280/0.4)]",
                !active && "text-muted-foreground hover:text-foreground hover:bg-background/60",
              )}
            >
              <RadioGroupItem value={opt.value} className="sr-only" aria-label={opt.label} />
              {opt.label}
            </label>
          );
        })}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">{description} До 2 минут за запись.</p>
    </div>
  );
}
