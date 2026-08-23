import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_DEVICE_VALUE } from "@/lib/types";

interface InputDeviceSettingProps {
  value: string | null;
  options: { value: string; label: string }[];
  isLoading: boolean;
  onRefresh: () => void;
  onChange: (value: string | null) => void;
}

export function InputDeviceSetting({
  value,
  options,
  isLoading,
  onRefresh,
  onChange,
}: InputDeviceSettingProps) {
  const selectValue = value === null ? DEFAULT_DEVICE_VALUE : value;
  const visibleOptions = options.filter(
    (option) => option.value.trim() && option.label.trim(),
  );

  const handleChange = (v: string) => {
    onChange(v === DEFAULT_DEVICE_VALUE ? null : v);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="input-device">Устройство ввода</Label>
      <Select
        value={selectValue}
        onValueChange={handleChange}
        onOpenChange={(open) => {
          // Opening the dropdown force-refreshes the device list so a
          // newly plugged microphone appears without an app restart.
          if (open) onRefresh();
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
