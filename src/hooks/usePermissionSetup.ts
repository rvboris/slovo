import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useRef, useState } from "react";
import type { ShortcutPermissionSetup } from '@/lib/types';
import { getErrorMessage } from '@/lib/types';
import { invoke } from "@tauri-apps/api/core";

const SCROLL_DELAY_MS = 0;
const COPY_LABEL_RESET_MS = 2200;

function useUpdateAckGate({ setup, setCopyInstallDisabled }: Readonly<{ setup: ShortcutPermissionSetup | null; setCopyInstallDisabled: Dispatch<SetStateAction<boolean>> }>): (ack: boolean, currentSetup?: ShortcutPermissionSetup | null) => void {
 const updateAckGate = useCallback(
    (ack: boolean, currentSetup?: ShortcutPermissionSetup | null) => {
      let selectedSetup = currentSetup;
      if (selectedSetup === undefined) { selectedSetup = setup; }
      const hasInstall = Boolean(selectedSetup?.installCommands?.some(
        (line) => line.trim() !== "",
      ));
      setCopyInstallDisabled(!ack || !hasInstall);
    },
    [setup, setCopyInstallDisabled],
  );
 return updateAckGate;
}

async function withLoadingCleanup(operation: () => Promise<void>, finishLoading: () => void): Promise<void> {
  try { await operation(); }
  finally { finishLoading(); }
}

function useLoadSetup({ loadingRef, setLoading, setSetup, setAckChecked, setStateMessage, setCopyInstallDisabled, setCopyRevokeDisabled, setVerifyDisabled, updateAckGate }: Readonly<{ loadingRef: RefObject<boolean>; setLoading: Dispatch<SetStateAction<boolean>>; setSetup: Dispatch<SetStateAction<ShortcutPermissionSetup | null>>; setAckChecked: Dispatch<SetStateAction<boolean>>; setStateMessage: Dispatch<SetStateAction<string>>; setCopyInstallDisabled: Dispatch<SetStateAction<boolean>>; setCopyRevokeDisabled: Dispatch<SetStateAction<boolean>>; setVerifyDisabled: Dispatch<SetStateAction<boolean>>; updateAckGate: (ack: boolean, currentSetup?: ShortcutPermissionSetup | null) => void }>): () => Promise<void> {
 const resetSetup = useCallback((): void => {
    loadingRef.current = true;
    setLoading(true);
    setSetup(null);
    setAckChecked(false);
    setStateMessage("");
    setCopyInstallDisabled(true);
    setCopyRevokeDisabled(true);
    setVerifyDisabled(true);

 }, [loadingRef, setLoading, setSetup, setAckChecked, setStateMessage, setCopyInstallDisabled, setCopyRevokeDisabled, setVerifyDisabled]);
 const applySetup = useCallback((result: Readonly<ShortcutPermissionSetup>): void => {
      if (result.supported === false) {
        setStateMessage(
          "Настройка доступа не поддерживается в этой системе. Глобальное сочетание может быть недоступно.",
        );
      } else {
        setSetup(result);
        setStateMessage("");
        setCopyRevokeDisabled(
          !(result.revokeCommands ?? []).some((line) => line.trim() !== ""),
        );
        updateAckGate(false, result);
      }
 }, [setStateMessage, setSetup, setCopyRevokeDisabled, updateAckGate]);
   const finishLoading = useCallback((): void => {
    setLoading(false);
    setVerifyDisabled(false);
    loadingRef.current = false;
  }, [setLoading, setVerifyDisabled, loadingRef]);
  const loadSetup = useCallback(async (): Promise<void> => {
    if (loadingRef.current) {return;}
    resetSetup();
    await withLoadingCleanup(async (): Promise<void> => {
    try {
       applySetup(await invoke<ShortcutPermissionSetup>("get_shortcut_permission_setup"));
    } catch (error) {
      setSetup(null);
      setStateMessage(
        getErrorMessage(
          error,
          "Не удалось загрузить инструкции по настройке доступа.",
        ),
      );
     }
    }, finishLoading);
   }, [applySetup, resetSetup, loadingRef, setSetup, setStateMessage, finishLoading]);
 return loadSetup;
}

function useOpen({ setVisible, setAckChecked, loadSetup, panelRef }: Readonly<{ setVisible: Dispatch<SetStateAction<boolean>>; setAckChecked: Dispatch<SetStateAction<boolean>>; loadSetup: () => Promise<void>; panelRef: RefObject<HTMLElement | null> }>): () => void {
 const open = useCallback((): void => {
    setVisible(true);
    setAckChecked(false);
    void loadSetup();
    // Scroll into view after render
    globalThis.setTimeout((): void => {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, SCROLL_DELAY_MS);
  }, [loadSetup, setVisible, setAckChecked, panelRef]);
 return open;
}

function useClose({ setVisible, setSetup, setAckChecked, setStateMessage, setLoading, setCopyInstallDisabled, setCopyRevokeDisabled }: Readonly<{ setVisible: Dispatch<SetStateAction<boolean>>; setSetup: Dispatch<SetStateAction<ShortcutPermissionSetup | null>>; setAckChecked: Dispatch<SetStateAction<boolean>>; setStateMessage: Dispatch<SetStateAction<string>>; setLoading: Dispatch<SetStateAction<boolean>>; setCopyInstallDisabled: Dispatch<SetStateAction<boolean>>; setCopyRevokeDisabled: Dispatch<SetStateAction<boolean>> }>): () => void {
 const close = useCallback((): void => {
    setVisible(false);
    setSetup(null);
    setAckChecked(false);
    setStateMessage("");
    setLoading(false);
    setCopyInstallDisabled(true);
    setCopyRevokeDisabled(true);
  }, [setVisible, setSetup, setAckChecked, setStateMessage, setLoading, setCopyInstallDisabled, setCopyRevokeDisabled]);
 return close;
}

function useHandleAckChange({ setAckChecked, updateAckGate }: Readonly<{ setAckChecked: Dispatch<SetStateAction<boolean>>; updateAckGate: (ack: boolean, currentSetup?: ShortcutPermissionSetup | null) => void }>): (checked: boolean) => void {
 const handleAckChange = useCallback(
    (checked: boolean) => {
      setAckChecked(checked);
      updateAckGate(checked);
    },
    [updateAckGate, setAckChecked],
  );
 return handleAckChange;
}

function legacyCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  try {
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(textarea);
    textarea.select();
    return document.execCommand("copy");
  } catch { return false; }
  finally { textarea.remove(); }
}
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return legacyCopy(text); }
}
function copyLabel(copied: boolean): string {
  if (copied) { return "Скопировано"; }
  return "Не удалось скопировать";
}
function copyMessage(copied: boolean): string {
  if (copied) { return "Команды скопированы в буфер обмена."; }
  return "Не удалось скопировать. Выделите команды вручную.";
}
async function reportCopyResult(text: string, setLabel: Dispatch<SetStateAction<string>>, setMessage: Dispatch<SetStateAction<string>>): Promise<void> {
  const copied = await copyText(text);
  setLabel(copyLabel(copied));
  setMessage(copyMessage(copied));
}
function useCopyCommands({ setup, setCopyRevokeLabel, setCopyInstallLabel, setCopyRevokeDisabled, setCopyInstallDisabled, setStateMessage, ackChecked }: Readonly<{ setup: ShortcutPermissionSetup | null; setCopyRevokeLabel: Dispatch<SetStateAction<string>>; setCopyInstallLabel: Dispatch<SetStateAction<string>>; setCopyRevokeDisabled: Dispatch<SetStateAction<boolean>>; setCopyInstallDisabled: Dispatch<SetStateAction<boolean>>; setStateMessage: Dispatch<SetStateAction<string>>; ackChecked: boolean }>): (kind: "install" | "revoke") => Promise<void> {
 const copyCommands = useCallback(
    async (kind: "install" | "revoke"): Promise<void> => {
      if (!setup) {return;}
       const target = {
         install: { commands: setup.installCommands, disable: setCopyInstallDisabled, label: setCopyInstallLabel },
         revoke: { commands: setup.revokeCommands, disable: setCopyRevokeDisabled, label: setCopyRevokeLabel },
       }[kind];
      const text = (target.commands ?? []).filter(line => line.trim() !== "").join("\n");
      if (text === "") { return; }

      target.disable(true);

       await reportCopyResult(text, target.label, setStateMessage);

      globalThis.setTimeout((): void => {
        target.label("Копировать");
        if (kind === "install") {
           target.disable(!ackChecked);
         } else {
           target.disable(false);
        }
      }, COPY_LABEL_RESET_MS);
    },
    [setup, ackChecked, setCopyRevokeLabel, setCopyInstallLabel, setCopyRevokeDisabled, setCopyInstallDisabled, setStateMessage],
  );
 return copyCommands;
}

function usePermissionPanel(): { visible: boolean; setVisible: Dispatch<SetStateAction<boolean>>; loading: boolean; setLoading: Dispatch<SetStateAction<boolean>>; stateMessage: string; setStateMessage: Dispatch<SetStateAction<string>>; setup: ShortcutPermissionSetup | null; setSetup: Dispatch<SetStateAction<ShortcutPermissionSetup | null>>; ackChecked: boolean; setAckChecked: Dispatch<SetStateAction<boolean>> } {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stateMessage, setStateMessage] = useState("");
  const [setup, setSetup] = useState<ShortcutPermissionSetup | null>(null);
  const [ackChecked, setAckChecked] = useState(false);

 return { ackChecked, loading, setAckChecked, setLoading, setSetup, setStateMessage, setVisible, setup, stateMessage, visible };
}
function usePermissionCopyState(): { copyInstallLabel: string; setCopyInstallLabel: Dispatch<SetStateAction<string>>; copyRevokeLabel: string; setCopyRevokeLabel: Dispatch<SetStateAction<string>>; copyInstallDisabled: boolean; setCopyInstallDisabled: Dispatch<SetStateAction<boolean>>; copyRevokeDisabled: boolean; setCopyRevokeDisabled: Dispatch<SetStateAction<boolean>> } {
  const [copyInstallLabel, setCopyInstallLabel] = useState("Копировать");
  const [copyRevokeLabel, setCopyRevokeLabel] = useState("Копировать");
  const [copyInstallDisabled, setCopyInstallDisabled] = useState(true);
  const [copyRevokeDisabled, setCopyRevokeDisabled] = useState(true);

 return { copyInstallDisabled, copyInstallLabel, copyRevokeDisabled, copyRevokeLabel, setCopyInstallDisabled, setCopyInstallLabel, setCopyRevokeDisabled, setCopyRevokeLabel };
}
function usePermissionLifecycle(): { verifyDisabled: boolean; setVerifyDisabled: Dispatch<SetStateAction<boolean>>; loadingRef: RefObject<boolean>; panelRef: RefObject<HTMLElement | null> } {
  const [verifyDisabled, setVerifyDisabled] = useState(false);
  const loadingRef = useRef(false);
  const panelRef = useRef<HTMLElement | null>(null);

 return { loadingRef, panelRef, setVerifyDisabled, verifyDisabled };
}

interface PermissionSetupResult {
  ackChecked: boolean;
  close: () => void;
  copyCommands: (kind: "install" | "revoke") => Promise<void>;
  copyInstallDisabled: boolean;
  copyInstallLabel: string;
  copyRevokeDisabled: boolean;
  copyRevokeLabel: string;
  handleAckChange: (checked: boolean) => void;
  installCommands: string[];
  loading: boolean;
  open: () => void;
  panelRef: { current: HTMLElement | null };
  revokeCommands: string[];
  setVerifyDisabled: (value: boolean | ((previous: boolean) => boolean)) => void;
  setup: ShortcutPermissionSetup | null;
  stateMessage: string;
  verifyDisabled: boolean;
  visible: boolean;
}

export function usePermissionSetup(): PermissionSetupResult {
  const { visible, setVisible, loading, setLoading, stateMessage, setStateMessage, setup, setSetup, ackChecked, setAckChecked } = usePermissionPanel();
  const { copyInstallLabel, setCopyInstallLabel, copyRevokeLabel, setCopyRevokeLabel, copyInstallDisabled, setCopyInstallDisabled, copyRevokeDisabled, setCopyRevokeDisabled } = usePermissionCopyState();
  const { verifyDisabled, setVerifyDisabled, loadingRef, panelRef } = usePermissionLifecycle();


  const updateAckGate = useUpdateAckGate({ setCopyInstallDisabled, setup });

  const loadSetup = useLoadSetup({ loadingRef, setAckChecked, setCopyInstallDisabled, setCopyRevokeDisabled, setLoading, setSetup, setStateMessage, setVerifyDisabled, updateAckGate });

  const open = useOpen({ loadSetup, panelRef, setAckChecked, setVisible });

  const close = useClose({ setAckChecked, setCopyInstallDisabled, setCopyRevokeDisabled, setLoading, setSetup, setStateMessage, setVisible });

  const handleAckChange = useHandleAckChange({ setAckChecked, updateAckGate });

  const copyCommands = useCopyCommands({ ackChecked, setCopyInstallDisabled, setCopyInstallLabel, setCopyRevokeDisabled, setCopyRevokeLabel, setStateMessage, setup });

  return {
    ackChecked,
    close,
    copyCommands,
    copyInstallDisabled,
    copyInstallLabel,
    copyRevokeDisabled,
    copyRevokeLabel,
    handleAckChange,
    installCommands: (setup?.installCommands ?? []).filter(line => line.trim() !== ""),
    loading,
    open,
    panelRef,
    revokeCommands: (setup?.revokeCommands ?? []).filter(line => line.trim() !== ""),
    setVerifyDisabled,
    setup,
    stateMessage,
    verifyDisabled,
    visible,
  };
}
