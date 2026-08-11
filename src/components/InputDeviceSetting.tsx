import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface InputDeviceSettingProps {
  value: string | null;
  options: { value: string; label: string }[];
  isLoading: boolean;
  onLoad: () => void;
  onChange: (value: string | null) => void;
}

export function InputDeviceSetting({
  value,
  options,
  isLoading,
  onLoad,
  onChange,
}: InputDeviceSettingProps) {
  const selectValue = value === null ? "__default__" : value;
  const visibleOptions = options.filter(
    (option) => option.value.trim() && option.label.trim(),
  );

  const handleChange = (v: string) => {
    onChange(v === "__default__" ? null : v);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="input-device">Устройство ввода</Label>
      <Select
        value={selectValue}
        onValueChange={handleChange}
        onOpenChange={(open) => {
          if (open) onLoad();
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
            <div
              className="px-2 py-1.5 text-sm text-muted-foreground"
              role="status"
            >
              Загрузка устройств…
            </div>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
