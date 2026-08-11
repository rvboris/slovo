import { useState, useEffect, useCallback, useRef } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useSettings } from "@/hooks/useSettings";
import { useHotkey } from "@/hooks/useHotkey";
import { useStatus } from "@/hooks/useStatus";
import { useShortcutStatus } from "@/hooks/useShortcutStatus";
import { usePermissionSetup } from "@/hooks/usePermissionSetup";
import { useInputDevices } from "@/hooks/useInputDevices";
import { useServerAvailability } from "@/hooks/useServerAvailability";
import { StatusHeader } from "@/components/StatusHeader";
import { HotkeySetting } from "@/components/HotkeySetting";
import { ServerUrlSetting } from "@/components/ServerUrlSetting";
import { InputDeviceSetting } from "@/components/InputDeviceSetting";
import { TriggerSetting } from "@/components/TriggerSetting";
import { PermissionPanel } from "@/components/PermissionPanel";
import { ErrorBanner } from "@/components/ErrorBanner";
import { SaveIndicator } from "@/components/SaveIndicator";
import type { TriggerType } from "@/lib/types";

export default function App() {
  useTheme();

  // Error state
  const [errorMessage, setErrorMessage] = useState("");
  const lastFailedActionRef = useRef<(() => Promise<void>) | null>(null);

  const showError = useCallback(
    (message: string, retry?: () => Promise<void>) => {
      setErrorMessage(message);
      lastFailedActionRef.current = retry ?? null;
    },
    [],
  );

  const hideError = useCallback(() => {
    setErrorMessage("");
  }, []);

  const retryLastAction = useCallback(async () => {
    const action = lastFailedActionRef.current;
    if (!action) return;
    try {
      await action();
    } catch {
      // The action already presents a useful error to the user.
    }
  }, []);

  // Settings
  const {
    settings,
    isLoaded: settingsLoaded,
    saveState,
    loadSettings,
    saveSettings,
    scheduleServerSave,
    saveServerNow,
    updateSetting,
  } = useSettings({ onError: showError, onClearError: hideError });

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
    onError: showError,
    onClearError: hideError,
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
    (hotkey: string) => {
      void saveSettings({ ...settings, hotkey }).catch(() => undefined);
    },
    [saveSettings, settings],
  );

  const hotkey = useHotkey({
    hotkey: settings.hotkey,
    enabled: settingsLoaded,
    onSave: handleHotkeySave,
    onError: showError,
  });

  // Initial load
  useEffect(() => {
    void loadSettings();
    void loadShortcutStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return (
    <main className="mx-auto flex h-dvh w-full max-w-[520px] flex-col gap-5 px-6 py-6 overflow-hidden">
      <StatusHeader kind={status.kind} text={status.text} />

      <div className="flex flex-col gap-6 flex-1 min-h-0">
        <HotkeySetting
          hotkey={settings.hotkey}
          isCapturing={hotkey.isCapturing}
          captureMessage={hotkey.captureMessage}
          hotkeyDisabled={!settingsLoaded || hotkey.isStartingCapture}
          onHotkeyClick={hotkey.handleClick}
          shortcutView={shortcutStatus.view}
          shortcutText={shortcutStatus.text}
          shortcutCanRetry={shortcutStatus.canRetry}
          shortcutCanSetup={shortcutStatus.canSetup}
          shortcutIsBusy={shortcutStatus.isBusy}
          onRetry={() => void retryShortcutBackend()}
          onSetup={permission.open}
        />

        <ServerUrlSetting
          value={settings.serverUrl}
          availability={serverAvailability.status}
          onScheduleSave={scheduleServerSave}
          onBlurSave={saveServerNow}
          onCheckAvailability={(url) => void serverAvailability.check(url)}
          onInvalidateAvailability={serverAvailability.invalidate}
        />

        <InputDeviceSetting
          value={settings.inputDevice}
          options={deviceOptions}
          isLoading={areInputDevicesLoading}
          onLoad={() => void loadInputDevices()}
          onChange={handleDeviceChange}
        />

        <TriggerSetting
          value={settings.triggerType}
          onChange={handleTriggerChange}
        />
      </div>

      <ErrorBanner
        message={errorMessage}
        hasRetry={!!lastFailedActionRef.current}
        onRetry={() => void retryLastAction()}
      />

      <PermissionPanel
        visible={permission.visible}
        loading={permission.loading}
        stateMessage={permission.stateMessage}
        setup={permission.setup}
        installCommands={permission.installCommands}
        revokeCommands={permission.revokeCommands}
        ackChecked={permission.ackChecked}
        copyInstallLabel={permission.copyInstallLabel}
        copyRevokeLabel={permission.copyRevokeLabel}
        copyInstallDisabled={permission.copyInstallDisabled}
        copyRevokeDisabled={permission.copyRevokeDisabled}
        verifyDisabled={permission.verifyDisabled}
        panelRef={permission.panelRef}
        onClose={permission.close}
        onAckChange={permission.handleAckChange}
        onCopyInstall={() => void permission.copyCommands("install")}
        onCopyRevoke={() => void permission.copyCommands("revoke")}
        onVerify={handleVerify}
      />

      <SaveIndicator text={saveState.text} kind={saveState.kind} />
    </main>
  );
}
