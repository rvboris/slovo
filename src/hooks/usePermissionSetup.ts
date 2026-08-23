import { useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Commands } from "@/lib/ipc";
import {
  type ShortcutPermissionSetup,
  getErrorMessage,
} from "@/lib/types";

export function usePermissionSetup() {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stateMessage, setStateMessage] = useState("");
  const [setup, setSetup] = useState<ShortcutPermissionSetup | null>(null);
  const [ackChecked, setAckChecked] = useState(false);
  const [copyInstallLabel, setCopyInstallLabel] = useState("Копировать");
  const [copyRevokeLabel, setCopyRevokeLabel] = useState("Копировать");
  const [copyInstallDisabled, setCopyInstallDisabled] = useState(true);
  const [copyRevokeDisabled, setCopyRevokeDisabled] = useState(true);
  const [verifyDisabled, setVerifyDisabled] = useState(false);
  const loadingRef = useRef(false);
  const panelRef = useRef<HTMLElement | null>(null);

  const installCommands = (setup?.installCommands ?? []).filter(
    (line) => line && line.trim(),
  );
  const revokeCommands = (setup?.revokeCommands ?? []).filter(
    (line) => line && line.trim(),
  );

  const updateAckGate = useCallback(
    (ack: boolean, currentSetup?: ShortcutPermissionSetup | null) => {
      const s = currentSetup !== undefined ? currentSetup : setup;
      const hasInstall = !!s?.installCommands?.some(
        (line) => line && line.trim(),
      );
      setCopyInstallDisabled(!ack || !hasInstall);
    },
    [setup],
  );

  const loadSetup = useCallback(async (): Promise<void> => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setSetup(null);
    setAckChecked(false);
    setStateMessage("");
    setCopyInstallDisabled(true);
    setCopyRevokeDisabled(true);
    setVerifyDisabled(true);

    try {
      const result = await invoke<ShortcutPermissionSetup>(
        Commands.getShortcutPermissionSetup,
      );
      if (result.supported === false) {
        setStateMessage(
          "Настройка доступа не поддерживается в этой системе. " +
            "Глобальное сочетание может быть недоступно.",
        );
      } else {
        setSetup(result);
        setStateMessage("");
        setCopyRevokeDisabled(
          !(result.revokeCommands ?? []).some((line) => line && line.trim()),
        );
        updateAckGate(false, result);
      }
    } catch (error) {
      setSetup(null);
      setStateMessage(
        getErrorMessage(
          error,
          "Не удалось загрузить инструкции по настройке доступа.",
        ),
      );
    } finally {
      setLoading(false);
      setVerifyDisabled(false);
      loadingRef.current = false;
    }
  }, [updateAckGate]);

  const open = useCallback(() => {
    setVisible(true);
    setAckChecked(false);
    void loadSetup();
    // Scroll into view after render
    window.setTimeout(() => {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }, [loadSetup]);

  const close = useCallback(() => {
    setVisible(false);
    setSetup(null);
    setAckChecked(false);
    setStateMessage("");
    setLoading(false);
    setCopyInstallDisabled(true);
    setCopyRevokeDisabled(true);
  }, []);

  const handleAckChange = useCallback(
    (checked: boolean) => {
      setAckChecked(checked);
      updateAckGate(checked);
    },
    [updateAckGate],
  );

  const copyCommands = useCallback(
    async (kind: "install" | "revoke"): Promise<void> => {
      if (!setup) return;
      const source =
        kind === "install" ? setup.installCommands : setup.revokeCommands;
      const commands = (source ?? []).filter((line) => line && line.trim());
      if (commands.length === 0) return;

      const text = commands.join("\n");
      const setLabel =
        kind === "install" ? setCopyInstallLabel : setCopyRevokeLabel;
      const setDisabled =
        kind === "install" ? setCopyInstallDisabled : setCopyRevokeDisabled;
      const originalLabel = "Копировать";

      setDisabled(true);

      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch {
        copied = false;
      }

      if (!copied) {
        try {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          textarea.style.pointerEvents = "none";
          document.body.appendChild(textarea);
          textarea.select();
          copied = document.execCommand("copy");
          document.body.removeChild(textarea);
        } catch {
          copied = false;
        }
      }

      setLabel(copied ? "Скопировано" : "Не удалось скопировать");
      setStateMessage(
        copied
          ? "Команды скопированы в буфер обмена."
          : "Не удалось скопировать. Выделите команды вручную.",
      );

      window.setTimeout(() => {
        setLabel(originalLabel);
        if (kind === "install") {
          setCopyInstallDisabled(!ackChecked);
        } else {
          setCopyRevokeDisabled(false);
        }
      }, 2200);
    },
    [setup, ackChecked],
  );

  return {
    visible,
    loading,
    stateMessage,
    setup,
    installCommands,
    revokeCommands,
    ackChecked,
    copyInstallLabel,
    copyRevokeLabel,
    copyInstallDisabled,
    copyRevokeDisabled,
    verifyDisabled,
    panelRef,
    open,
    close,
    handleAckChange,
    copyCommands,
    setVerifyDisabled,
  };
}
