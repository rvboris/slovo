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
        className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5"
        aria-label="Тип срабатывания"
      >
        {options.map((opt) => (
          <label
            key={opt.value}
            className={cn(
              "relative flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-semibold cursor-pointer transition-colors",
              value === opt.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <RadioGroupItem
              value={opt.value}
              className="sr-only"
              aria-label={opt.label}
            />
            {opt.label}
          </label>
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">
        {triggerDescriptions[value]}
      </p>
    </div>
  );
}
