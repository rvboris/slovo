import { useEffect, useRef } from "react";

export function useTheme(): void {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (dark: boolean) => {
      document.documentElement.classList.toggle("dark", dark);
    };
    apply(mq.matches);

    const handler = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener("change", handler);
    cleanupRef.current = () => mq.removeEventListener("change", handler);

    return () => {
      cleanupRef.current?.();
    };
  }, []);
}
