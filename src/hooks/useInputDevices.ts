import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InputDevice } from '@/lib/types';
import { getErrorMessage } from '@/lib/types';
import { invoke } from "@tauri-apps/api/core";

interface DeviceOption {
  readonly value: string;
  readonly label: string;
}

const defaultOption: DeviceOption = {
  label: "Системное по умолчанию",
  value: "__default__",
};

let cachedDevices: InputDevice[] | null = null;
let sharedRequest: Promise<InputDevice[]> | null = null;

 async function getInputDevices(force: boolean): Promise<InputDevice[]> {
  if (sharedRequest) {
    const devices = await sharedRequest;
    return devices;
  }
  if (!force && cachedDevices) {return cachedDevices;}

  const request = invoke<InputDevice[]>("list_input_devices");
  const trackedRequest = (async (): Promise<InputDevice[]> => {
    try {
      const devices = await request;
      cachedDevices = devices;
      return devices;
    } finally {
      // No other request can start while sharedRequest is pending.
      sharedRequest = null;
    }
  })();

  sharedRequest = trackedRequest;
  return trackedRequest;
}
async function updateDevices(force: boolean, mounted: Readonly<RefObject<boolean>>, setDevices: Dispatch<SetStateAction<InputDevice[] | null>>): Promise<void> {
  const devices = await getInputDevices(force);
  if (mounted.current) { setDevices(devices); }
}
function reportDeviceError(error: unknown, mounted: boolean, onError: (message: string) => void): void {
  if (mounted) { onError(getErrorMessage(error, "Не удалось получить список устройств ввода.")); }
}
function useLoad({ loadingRef, devices, setIsLoading, mounted, setDevices, onError }: Readonly<{ loadingRef: RefObject<boolean>; devices: readonly InputDevice[] | null; setIsLoading: Dispatch<SetStateAction<boolean>>; mounted: RefObject<boolean>; setDevices: Dispatch<SetStateAction<InputDevice[] | null>>; onError: (message: string) => void }>): (force?: boolean) => Promise<void> {
 const load = useCallback(
    async (force = false): Promise<void> => {
      if (loadingRef.current || (!force && devices !== null)) {return;}

      loadingRef.current = true;
      setIsLoading(true);
      await (async (): Promise<void> => {
        try {
          await updateDevices(force, mounted, setDevices);
        } catch (error) {
          reportDeviceError(error, mounted.current, onError);
        }
      })().finally((): void => {
        loadingRef.current = false;
        if (mounted.current) {setIsLoading(false);}
      });
    },
    [devices, onError, loadingRef, setIsLoading, mounted, setDevices],
  );
 return load;
}

function unloadedDeviceOptions(currentDevice: string | null): DeviceOption[] {
  const options = [defaultOption];
  if (currentDevice !== null && currentDevice !== "") { options.push({ label: currentDevice, value: currentDevice }); }
  return options;
}
function useDeviceOptions(currentDevice: string | null, devices: readonly InputDevice[] | null): DeviceOption[] {
  const options = useMemo(() => {
    const opts: DeviceOption[] = [defaultOption];
    if (devices === null) { return unloadedDeviceOptions(currentDevice); }

    const names = devices.map(device => device.name.trim()).filter(name => name !== "");
    opts.push(...names.map(name => ({ label: name, value: name })));
    if (currentDevice !== null && currentDevice !== "" && !names.includes(currentDevice)) {
      opts.push({
        label: `Недоступно: ${currentDevice}`,
        value: currentDevice,
      });
    }
    return opts;
  }, [currentDevice, devices]);
  return options;
}

export function useInputDevices(
  currentDevice: string | null,
  onError: (message: string) => void,
): {
  isLoading: boolean;
  load: (force?: boolean) => Promise<void>;
  options: DeviceOption[];
  reload: () => Promise<void>;
} {
  const [devices, setDevices] = useState<InputDevice[] | null>(
    () => cachedDevices,
  );
  const [isLoading, setIsLoading] = useState(false);
  const mounted = useRef(true);
  const loadingRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  const load = useLoad({ devices, loadingRef, mounted, onError, setDevices, setIsLoading });

  const reload = useCallback(async (): Promise<void> => { await load(true); }, [load]);

  const options = useDeviceOptions(currentDevice, devices);

  return { isLoading, load, options, reload };
}
