import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { JSX } from "react";
import { Label } from "@/components/ui/label";

interface InputDeviceSettingProps {
  readonly value: string | null;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly isLoading: boolean;
  readonly onLoad: () => void;
  readonly onChange: (value: string | null) => void;
}

export function InputDeviceSetting({
  value,
  options,
  isLoading,
  onLoad,
  onChange,
}: InputDeviceSettingProps): JSX.Element | null {
  const selectValue = value ?? "__default__";
  const visibleOptions = options.filter(
    (option) => option.value.trim() !== "" && option.label.trim() !== "",
  );

  const handleChange = (next: string): void => {
    if (next === "__default__") {
      onChange(null);
    } else {
      onChange(next);
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="input-device">Устройство ввода</Label>
      <Select
        value={selectValue}
        onValueChange={handleChange}
        onOpenChange={(open) => {
          if (open) {
            onLoad();
          }
        }}
      >
        <SelectTrigger id="input-device">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {visibleOptions.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
          {isLoading && (
            <output className="block text-xs text-muted-foreground">Загрузка устройств…</output>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
