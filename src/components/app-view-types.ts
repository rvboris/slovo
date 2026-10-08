import type { RefObject } from "react";
import type { TriggerType } from "@/lib/types";
import type { useHotkey } from "@/hooks/useHotkey";
import type { useInputDevices } from "@/hooks/useInputDevices";
import type { usePermissionSetup } from "@/hooks/usePermissionSetup";
import type { useServerAvailability } from "@/hooks/useServerAvailability";
import type { useSettings } from "@/hooks/useSettings";
import type { useShortcutStatus } from "@/hooks/useShortcutStatus";
import type { useStatus } from "@/hooks/useStatus";
import type { useTheme } from "@/hooks/useTheme";

export interface AppViewProps {
  readonly theme: ReturnType<typeof useTheme>["theme"];
  readonly toggleTheme: () => void;
  readonly status: Readonly<ReturnType<typeof useStatus>>;
  readonly settings: Readonly<ReturnType<typeof useSettings>["settings"]>;
  readonly settingsLoaded: boolean;
  readonly hotkey: Readonly<ReturnType<typeof useHotkey>>;
  readonly shortcutStatus: Readonly<ReturnType<typeof useShortcutStatus>["status"]>;
  readonly retryShortcutBackend: () => Promise<void>;
  readonly permission: Readonly<Omit<ReturnType<typeof usePermissionSetup>, "installCommands" | "revokeCommands" | "panelRef" | "setup">> & { readonly installCommands: readonly string[]; readonly revokeCommands: readonly string[]; readonly panelRef: RefObject<HTMLElement | null>; readonly setup: Readonly<Omit<NonNullable<ReturnType<typeof usePermissionSetup>["setup"]>, "installCommands" | "revokeCommands">> | null }; 
  readonly serverAvailability: Readonly<ReturnType<typeof useServerAvailability>>;
  readonly scheduleServerSave: (value: string) => void;
  readonly saveServerNow: (value: string) => void;
  readonly deviceOptions: readonly Readonly<ReturnType<typeof useInputDevices>["options"][number]>[];
  readonly areInputDevicesLoading: boolean;
  readonly loadInputDevices: () => Promise<void>;
  readonly handleDeviceChange: (device: string | null) => void;
  readonly handleTriggerChange: (trigger: TriggerType) => void;
  readonly correctionLabel: string;
  readonly openCorrection: () => Promise<void>;
  readonly errorMessage: string;
  readonly hasRetry: boolean;
  readonly retryLastAction: () => Promise<void>;
  readonly handleVerify: () => void;
  readonly saveMessage: string;
}
