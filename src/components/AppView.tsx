import type { AppViewProps } from "./app-view-types";
import { Button } from "@/components/ui/button";
import { HotkeySetting } from "@/components/HotkeySetting";
import { InputDeviceSetting } from "@/components/InputDeviceSetting";
import type { JSX } from "react";
import { NotificationStack } from "@/components/NotificationStack";
import { PermissionPanel } from "@/components/PermissionPanel";
import { ServerUrlSetting } from "@/components/ServerUrlSetting";
import { StatusHeader } from "@/components/StatusHeader";
import { TriggerSetting } from "@/components/TriggerSetting";

export function AppView({ theme, toggleTheme, status, settings, settingsLoaded, hotkey, shortcutStatus, retryShortcutBackend, permission, serverAvailability, scheduleServerSave, saveServerNow, deviceOptions, areInputDevicesLoading, loadInputDevices, handleDeviceChange, handleTriggerChange, correctionLabel, openCorrection, errorMessage, hasRetry, retryLastAction, handleVerify, saveMessage }: AppViewProps): JSX.Element {
  let correctionTone = "text-[var(--destructive)]";
  if (settings.llmServerUrl !== null && settings.llmServerUrl !== "") { correctionTone = "text-emerald-600 dark:text-emerald-400"; }
  return (
    <main className="flex h-dvh w-full flex-col gap-5 overflow-hidden">
      <StatusHeader kind={status.kind} text={status.text} theme={theme} onToggleTheme={toggleTheme} />

      <NotificationStack
        operationalError={status.operationalError}
        onDismissOperationalError={() => { status.dismissOperationalError(); }}
        warning={status.warning}
        onDismissWarning={() => { status.dismissWarning(); }}
        errorMessage={errorMessage}
        hasRetry={hasRetry}
        onRetry={() => { void retryLastAction(); }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      <div className="flex flex-col gap-6 [&>*]:shrink-0">
        <HotkeySetting
          hotkey={settings.hotkey}
          isCapturing={hotkey.isCapturing}
          captureMessage={hotkey.captureMessage}
          hotkeyDisabled={!settingsLoaded || hotkey.isStartingCapture || ["recording", "transcribing", "correcting"].includes(status.kind)}
          onHotkeyClick={hotkey.handleClick}
          shortcutView={shortcutStatus.view}
          shortcutText={shortcutStatus.text}
          shortcutCanRetry={shortcutStatus.canRetry}
          shortcutCanSetup={shortcutStatus.canSetup}
          shortcutIsBusy={shortcutStatus.isBusy}
          onRetry={() => { void retryShortcutBackend(); }}
          onSetup={() => { permission.open(); }}
        />

        <ServerUrlSetting
          value={settings.serverUrl}
          availability={serverAvailability.status}
          onScheduleSave={scheduleServerSave}
          onBlurSave={saveServerNow}
          onCheckAvailability={(url) => { void serverAvailability.check(url); }}
          onInvalidateAvailability={() => { serverAvailability.invalidate(); }}
        />

        <InputDeviceSetting
          value={settings.inputDevice}
          options={deviceOptions}
          isLoading={areInputDevicesLoading}
          onLoad={() => { void loadInputDevices(); }}
          onChange={handleDeviceChange}
        />

        <TriggerSetting
          value={settings.triggerType}
          onChange={handleTriggerChange}
        />

        <section className="flex items-center justify-between gap-4 border-t border-border pt-4">
          <div>
            <h2 className="text-sm font-semibold">Корректировка текста</h2>
            <p className={`mt-1 text-xs font-medium ${correctionTone}`}>{correctionLabel}</p>
          </div>
          <Button size="sm" variant="outline" disabled={!settingsLoaded} onClick={() => {
            void openCorrection();
          }}>Настроить</Button>
        </section>

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
        onClose={() => { permission.close(); }}
        onAckChange={permission.handleAckChange}
        onCopyInstall={() => { void permission.copyCommands("install"); }}
        onCopyRevoke={() => { void permission.copyCommands("revoke"); }}
        onVerify={handleVerify}
      />

      <output aria-live="polite" aria-atomic="true" className="text-xs text-muted-foreground">{saveMessage || "Настройки сохраняются автоматически"}</output>
      </div>
      </div>
    </main>
  );
}
