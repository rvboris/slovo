import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type InputDevice, getErrorMessage } from "@/lib/types";

interface DeviceOption {
  value: string;
  label: string;
}

export function useInputDevices(
  currentDevice: string | null,
  onError: (message: string) => void,
) {
  const [options, setOptions] = useState<DeviceOption[]>([
    { value: "__default__", label: "Системное по умолчанию" },
  ]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const devices = await invoke<InputDevice[]>("list_input_devices");
      const current = currentDevice ?? "";
      const opts: DeviceOption[] = [
        { value: "__default__", label: "Системное по умолчанию" },
      ];

      let found = !current;
      for (const dev of devices) {
        opts.push({ value: dev.value, label: dev.label });
        if (dev.value === current) found = true;
      }
      if (!found && current) {
        opts.push({ value: current, label: `Недоступно: ${current}` });
      }
      setOptions(opts);
    } catch (error) {
      onError(
        getErrorMessage(error, "Не удалось получить список устройств ввода."),
      );
    }
  }, [currentDevice, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  return { options, reload: load };
}
