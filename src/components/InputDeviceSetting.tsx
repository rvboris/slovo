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
  onChange: (value: string | null) => void;
}

export function InputDeviceSetting({
  value,
  options,
  onChange,
}: InputDeviceSettingProps) {
  const selectValue = value === null ? "__default__" : value;

  const handleChange = (v: string) => {
    onChange(v === "__default__" ? null : v);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="input-device">Устройство ввода</Label>
      <Select value={selectValue} onValueChange={handleChange}>
        <SelectTrigger id="input-device">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
