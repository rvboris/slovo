import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Theme = "light" | "dark";
const STORAGE_KEY = "theme";
function initialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  if (globalThis.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

async function publishTheme(theme: Theme): Promise<void> {
  try {
    await emit("slovo://theme-changed", theme);
  } catch {
    // Local preference remains available offline.
  }
}

function useThemeEvents(
  primary: boolean,
  current: Readonly<{ current: Theme }>,
  setTheme: (theme: Theme) => void,
): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    async function connect(): Promise<() => void> {
      if (primary) {
        return listen("slovo://theme-request", (): void => {
          void publishTheme(current.current);
        });
      }
      const dispose = await listen<unknown>("slovo://theme-changed", ({ payload }) => {
        if (!cancelled && (payload === "light" || payload === "dark")) {
          setTheme(payload);
        }
      });
      return dispose;
    }
    async function subscribe(): Promise<void> {
      try {
        const dispose = await connect();
        if (cancelled) {
          dispose();
          return;
        }
        unlisten = dispose;
        // Subscribe before requesting the primary window's current theme.
        if (!primary) {
          await emit("slovo://theme-request");
        }
      } catch {
        // Stored preference remains the offline fallback.
      }
    }
    void subscribe();
    const sync = (event: Readonly<Pick<StorageEvent, "key">>): void => {
      if (event.key === STORAGE_KEY) {
        setTheme(initialTheme());
      }
    };
    globalThis.addEventListener("storage", sync);
    return (): void => {
      cancelled = true;
      unlisten?.();
      globalThis.removeEventListener("storage", sync);
    };
  }, [primary, current, setTheme]);
}

function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const primary = getCurrentWindow().label === "main";
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const current = useRef(theme);
  useEffect((): void => {
    current.current = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useThemeEvents(primary, current, setTheme);

  const toggleTheme = useCallback((): void => {
    let next: Theme = "dark";
    if (current.current === "dark") {
      next = "light";
    }
    current.current = next;
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    void publishTheme(next);
  }, []);

  return { theme, toggleTheme };
}

export { type Theme, useTheme };
