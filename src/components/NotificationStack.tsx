import { ErrorBanner } from "@/components/ErrorBanner";
import type { JSX } from "react";

interface NotificationStackProps {
  readonly operationalError?: string;
  readonly onDismissOperationalError?: () => void;
  readonly warning: string;
  readonly onDismissWarning: () => void;
  readonly errorMessage: string;
  readonly hasRetry: boolean;
  readonly onRetry: () => void;
}

/**
 * Warning and error banners displayed together.
 */
export function NotificationStack({
  warning,
  onDismissWarning,
  errorMessage,
  hasRetry,
  onRetry,
  operationalError = "",
  onDismissOperationalError,
}: NotificationStackProps): JSX.Element | null {
  const empty = warning === "" && errorMessage === "" && operationalError === "";
  if (empty) {
    return null;
  }
  return (
    <div className="flex flex-col gap-5">
      {warning !== "" && (
        <div
          role="alert"
          className="mx-6 flex shrink-0 items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-200"
        >
          <p className="min-w-0 flex-1 break-words">{warning}</p>
          <button
            type="button"
            onClick={onDismissWarning}
            className="shrink-0 rounded underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
          >
            Скрыть
          </button>
        </div>
      )}
      {operationalError !== "" && (
        <div
          role="alert"
          className="mx-6 flex shrink-0 items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive"
        >
          <p className="min-w-0 flex-1 break-words">{operationalError}</p>
          <button
            type="button"
            onClick={onDismissOperationalError}
            aria-label="Скрыть ошибку предыдущей операции"
            className="shrink-0 rounded underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
          >
            Скрыть
          </button>
        </div>
      )}
      <ErrorBanner message={errorMessage} hasRetry={hasRetry} onRetry={onRetry} />
    </div>
  );
}
