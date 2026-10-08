import type { JSX, RefObject } from "react";
import { Button } from "@/components/ui/button";
import { useEffect } from "react";

interface CorrectionNoticesProps {
  readonly noticeRef: RefObject<HTMLElement | null>;
  readonly exitPending: boolean;
  readonly exitResolving: boolean;
  readonly confirmClose: boolean;
  readonly isSaving: boolean;
  readonly onCancelExit: () => void;
  readonly onApproveExit: () => void;
  readonly onKeepEditing: () => void;
  readonly onDiscardClose: () => void;
}

interface NoticeText {
  readonly exitText: string;
  readonly closeText: string;
}

function noticeText(isSaving: boolean): NoticeText {
  let exitText = "Запрошен выход из «Слово». Есть несохранённые изменения корректировки.";
  if (isSaving) { exitText = "Запрошен выход из «Слово». Идёт сохранение изменений — дождитесь завершения."; }
  let closeText = "Есть несохранённые изменения. Закрыть окно и потерять их?";
  if (isSaving) { closeText = "Идёт сохранение изменений. Дождитесь завершения, чтобы не потерять их."; }
  return { closeText, exitText };
}

interface ActionProps {
  readonly isSaving: boolean;
  readonly onPrimary: () => void;
  readonly onSecondary: () => void;
  readonly primaryDisabled: boolean;
  readonly primaryLabel: string;
  readonly secondaryLabel: string;
}

function noticeActions(props: ActionProps): JSX.Element {
  return (
    <>
      <Button size="sm" disabled={props.primaryDisabled} onClick={props.onPrimary}>{props.primaryLabel}</Button>
      <Button size="sm" variant="outline" disabled={props.isSaving || props.primaryDisabled} onClick={props.onSecondary}>{props.secondaryLabel}</Button>
    </>
  );
}

/**
 * App-exit and window-close confirmations for the correction window.
 * Rendered above the form so a pending decision is impossible to miss.
 */
export function CorrectionNotices({ noticeRef, exitPending, exitResolving, confirmClose, isSaving, onCancelExit, onApproveExit, onKeepEditing, onDiscardClose }: CorrectionNoticesProps): JSX.Element | null {
  const visible = exitPending || confirmClose;
  useEffect(() => {
    if (!visible) { return; }
    noticeRef.current?.scrollIntoView({ block: "start" });
    noticeRef.current?.focus();
  }, [visible, noticeRef]);
  if (!visible) { return null; }
  const { closeText, exitText } = noticeText(isSaving);
  let text = closeText;
  if (exitPending) { text = exitText; }
  let actions = noticeActions({ isSaving, onPrimary: onKeepEditing, onSecondary: onDiscardClose, primaryDisabled: false, primaryLabel: "Продолжить редактирование", secondaryLabel: "Закрыть без сохранения" });
  if (exitPending) {
    actions = noticeActions({ isSaving, onPrimary: onCancelExit, onSecondary: onApproveExit, primaryDisabled: exitResolving, primaryLabel: "Продолжить редактирование", secondaryLabel: "Выйти без сохранения" });
  }
  return (
    <section ref={noticeRef} tabIndex={-1} role="alert" className="mb-4 space-y-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
      <p>{text}</p>
      <div className="flex flex-wrap gap-2">{actions}</div>
      {isSaving && <output className="block">Дождитесь завершения сохранения.</output>}
    </section>
  );
}
