import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { type TriggerType, triggerDescriptions } from "@/lib/types";
import { cn } from "@/lib/utils";

interface TriggerSettingProps {
  value: TriggerType;
  onChange: (value: TriggerType) => void;
}

const options: { value: TriggerType; label: string }[] = [
  { value: "toggle", label: "Перекл." },
  { value: "hold", label: "Удержание" },
  { value: "auto-vad", label: "Авто-VAD" },
];

export function TriggerSetting({ value, onChange }: TriggerSettingProps) {
  return (
    <div className="space-y-2">
      <Label>Запуск записи</Label>
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as TriggerType)}
        className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1"
        aria-label="Тип срабатывания"
      >
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            // RadioGroupItem below renders the radio input inside this label;
            // the linter cannot see through the component boundary.
            // biome-ignore lint/a11y/noLabelWithoutControl: control provided by RadioGroupItem
            <label
              key={opt.value}
              className={cn(
                "relative flex items-center justify-center rounded-lg px-3 py-2 text-sm font-bold cursor-pointer transition-all duration-200",
                active
                  ? "bg-[var(--accent-vivid)] text-white shadow-[0_4px_14px_oklch(0.55_0.22_280/0.4)]"
                  : "text-muted-foreground hover:text-foreground hover:bg-background/60",
              )}
            >
              <RadioGroupItem
                value={opt.value}
                className="sr-only"
                aria-label={opt.label}
              />
              {opt.label}
            </label>
          );
        })}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">
        {triggerDescriptions[value]}
      </p>
    </div>
  );
}
