import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

interface ErrorBannerProps {
  message: string;
  hasRetry: boolean;
  onRetry: () => void;
}

export function ErrorBanner({ message, hasRetry, onRetry }: ErrorBannerProps) {
  if (!message) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex items-center gap-2 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive"
    >
      <AlertCircle className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1 min-w-0 font-medium">{message}</span>
      {hasRetry && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground text-xs"
        >
          Повторить
        </Button>
      )}
    </div>
  );
}
