import { useCallback, useEffect, useRef, useState } from "react";
import { AppView } from "@/components/AppView";
import type { JSX } from "react";
import type { TriggerType } from "@/lib/types";
import { useCorrectionScreen } from "@/hooks/use-correction-screen";
import { useHotkey } from "@/hooks/useHotkey";
import { useInputDevices } from "@/hooks/useInputDevices";
import { usePermissionSetup } from "@/hooks/usePermissionSetup";
import { useServerAvailability } from "@/hooks/useServerAvailability";
import { useSettings } from "@/hooks/useSettings";
import { useShortcutStatus } from "@/hooks/useShortcutStatus";
import { useStatus } from "@/hooks/useStatus";
import { useTheme } from "@/hooks/useTheme";

function correctionStatus(loaded: boolean, url: string | null): string {
  if (!loaded) { return "Загрузка…"; }
  if (url !== null && url !== "") { return "Включена"; }
  return "Выключена";
}

function useAppErrors(): Readonly<{ errorMessage: string; hasRetry: boolean; showError: (message: string, retry?: () => Promise<void>) => void; hideError: () => void; retryLastAction: () => Promise<void> }> {
  // Error state
  const [errorMessage, setErrorMessage] = useState("");
  const lastFailedActionRef = useRef<(() => Promise<void>) | null>(null);
  const [hasRetry, setHasRetry] = useState(false);

  const showError = useCallback(
    (message: string, retry?: () => Promise<void>) => {
      setErrorMessage(message);
      lastFailedActionRef.current = retry ?? null;
      setHasRetry(retry !== undefined);
    },
    [],
  );

  const hideError = useCallback(() => {
    setErrorMessage("");
  }, []);

  const retryLastAction = useCallback(async () => {
    const action = lastFailedActionRef.current;
    if (!action) {return;}
    try {
      await action();
    } catch {
      // The action already presents a useful error to the user.
    }
  }, []);

  return { errorMessage, hasRetry, hideError, retryLastAction, showError };
}

export function App() : JSX.Element | null {
  const { theme, toggleTheme } = useTheme();

  const { errorMessage, hasRetry, showError, hideError, retryLastAction } = useAppErrors();

  // Settings
  const {
    settings,
    isLoaded: settingsLoaded,
    saveMessage,
    loadSettings,
    saveSettings,
    scheduleServerSave,
    saveServerNow,
    updateSetting,
  } = useSettings({ onClearError: hideError, onError: showError });

  const serverAvailability = useServerAvailability(
    settings.serverUrl,
    settingsLoaded,
  );

  // Status
  const status = useStatus(showError);

  // Permission setup
  const permission = usePermissionSetup();

  // Shortcut status
  const handlePermissionDenied = useCallback(
    (canSetup: boolean) => {
      if (!canSetup && permission.visible) {
        permission.close();
      }
    },
    [permission],
  );

  const {
    status: shortcutStatus,
    retryShortcutBackend,
    loadShortcutStatus,
  } = useShortcutStatus({
    onClearError: hideError,
    onError: showError,
    onPermissionDenied: handlePermissionDenied,
  });

  // Input devices
  const {
    options: deviceOptions,
    load: loadInputDevices,
    isLoading: areInputDevicesLoading,
  } = useInputDevices(settings.inputDevice, showError);

  // Hotkey
  const handleHotkeySave = useCallback(
    (hotkey: string): void => {
      async function saveHotkey(): Promise<void> {
        try { await saveSettings({ hotkey }); } catch {
          // The settings hook reports this failure with a retry action.
        }
      }
      void saveHotkey();
    },
    [saveSettings],
  );

  const hotkey = useHotkey({
    enabled: settingsLoaded && !["recording", "transcribing", "correcting"].includes(status.kind),
    hotkey: settings.hotkey,
    onError: showError,
    onSave: handleHotkeySave,
  });

  // Initial load
  useEffect(() => {
    void loadSettings();
    void loadShortcutStatus();
      }, [loadSettings, loadShortcutStatus]);

  const handleVerify = useCallback(() => {
    permission.close();
    void retryShortcutBackend();
  }, [permission, retryShortcutBackend]);

  const handleTriggerChange = useCallback(
    (triggerType: TriggerType) => {
      updateSetting("triggerType", triggerType);
    },
    [updateSetting],
  );

  const handleDeviceChange = useCallback(
    (device: string | null) => {
      updateSetting("inputDevice", device);
    },
    [updateSetting],
  );

  const correctionLabel = correctionStatus(settingsLoaded, settings.llmServerUrl);
  const correction = useCorrectionScreen();
  return <AppView correctionContent={correction.content} correctionNotices={correction.notices} theme={theme} toggleTheme={toggleTheme} status={status} settings={settings} settingsLoaded={settingsLoaded} hotkey={hotkey} shortcutStatus={shortcutStatus} retryShortcutBackend={retryShortcutBackend} permission={permission} serverAvailability={serverAvailability} scheduleServerSave={scheduleServerSave} saveServerNow={saveServerNow} deviceOptions={deviceOptions} areInputDevicesLoading={areInputDevicesLoading} loadInputDevices={loadInputDevices} handleDeviceChange={handleDeviceChange} handleTriggerChange={handleTriggerChange} correctionLabel={correctionLabel} openCorrection={correction.open} errorMessage={errorMessage} hasRetry={hasRetry} retryLastAction={retryLastAction} handleVerify={handleVerify} saveMessage={saveMessage} />;
}
