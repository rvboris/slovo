import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type InputDevice, getErrorMessage } from "@/lib/types";

interface DeviceOption {
  value: string;
  label: string;
}

const defaultOption: DeviceOption = {
  value: "__default__",
  label: "Системное по умолчанию",
};

let cachedDevices: InputDevice[] | null = null;
let sharedRequest: Promise<InputDevice[]> | null = null;

function getInputDevices(force: boolean): Promise<InputDevice[]> {
  if (sharedRequest) return sharedRequest;
  if (!force && cachedDevices) return Promise.resolve(cachedDevices);

  const request = invoke<InputDevice[]>("list_input_devices");
  const trackedRequest = request
    .then((devices) => {
      cachedDevices = devices;
      return devices;
    })
    .finally(() => {
      if (sharedRequest === trackedRequest) sharedRequest = null;
    });

  sharedRequest = trackedRequest;
  return trackedRequest;
}

export function useInputDevices(
  currentDevice: string | null,
  onError: (message: string) => void,
) {
  const [devices, setDevices] = useState<InputDevice[] | null>(
    () => cachedDevices,
  );
  const [isLoading, setIsLoading] = useState(false);
  const mounted = useRef(true);
  const loading = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (force = false): Promise<void> => {
      if (loading.current || (!force && devices !== null)) return;

      loading.current = true;
      setIsLoading(true);
      try {
        const nextDevices = await getInputDevices(force);
        if (mounted.current) setDevices(nextDevices);
      } catch (error) {
        if (mounted.current) {
          onError(
            getErrorMessage(
              error,
              "Не удалось получить список устройств ввода.",
            ),
          );
        }
      } finally {
        loading.current = false;
        if (mounted.current) setIsLoading(false);
      }
    },
    [devices, onError],
  );

  const reload = useCallback(() => load(true), [load]);

  const options = useMemo(() => {
    const opts: DeviceOption[] = [defaultOption];
    if (devices === null) {
      if (currentDevice) {
        opts.push({ value: currentDevice, label: currentDevice });
      }
      return opts;
    }

    let found = !currentDevice;
    for (const device of devices) {
      const name = device.name.trim();
      if (!name) continue;

      opts.push({ value: name, label: name });
      if (name === currentDevice) found = true;
    }
    if (!found && currentDevice) {
      opts.push({
        value: currentDevice,
        label: `Недоступно: ${currentDevice}`,
      });
    }
    return opts;
  }, [currentDevice, devices]);

  return { options, load, reload, isLoading };
}
