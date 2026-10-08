import { LogicalSize, currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import type { RefObject } from "react";
import { useEffect } from "react";

const GAP_PX = 20;
const HIDDEN_HEIGHT = 0;
const MINIMUM_HEIGHT = 0;
const SIZE_EPSILON = 0.5;

/* oxlint-disable max-statements, max-lines-per-function, max-depth */

function measureExtra(el: { readonly offsetHeight: number }): number {
  if (el.offsetHeight === HIDDEN_HEIGHT) { return HIDDEN_HEIGHT; }
  return el.offsetHeight + GAP_PX;
}

/** Grows/shrinks the window to fit notifications while preserving its base height. */
export function useWindowAutoGrow(ref: RefObject<HTMLElement | null>): void {
  useEffect((): (() => void) | undefined => {
    const el = ref.current;
    if (el === null) { return undefined; }

    const win = getCurrentWindow();
    const lifecycle: { disposed: boolean } = { disposed: false };
    let running = false;
    let blocked = false;
    let desired = HIDDEN_HEIGHT;
    let applied = HIDDEN_HEIGHT;
    let baseHeight: number | null = null;

    const pump = async (): Promise<void> => {
      if (running || lifecycle.disposed || blocked) { return; }
      running = true;
      try {
        if (desired !== applied || baseHeight === null) {
          const target = desired;
          try {
            const [size, scale, monitor] = await Promise.all([
              win.innerSize(), win.scaleFactor(), currentMonitor(),
            ]);
            const { width, height } = size.toLogical(scale);
            baseHeight ??= height - applied;
            let bounded = target;
            if (monitor !== null) {
              const maxHeight = monitor.workArea.size.height / scale;
              bounded = Math.max(MINIMUM_HEIGHT, Math.min(target, maxHeight - baseHeight));
            }
            const actualTarget = baseHeight + bounded;
            if (Math.abs(height - actualTarget) < SIZE_EPSILON) {
              applied = bounded;
            } else {
              await win.setSize(new LogicalSize(width, actualTarget));
              const updatedSize = await win.innerSize();
              applied = Math.max(MINIMUM_HEIGHT, updatedSize.toLogical(scale).height - baseHeight);
              if (Math.abs(applied - bounded) >= SIZE_EPSILON && desired === target) { blocked = true; }
            }
          } catch {
            blocked = true;
          }
        }
      } finally {
        running = false;
        if (!blocked && desired !== applied) {
          // If a newer desired value arrived while IPC was pending, drain it now.
          void pump();
        }
      }
    };
    const observe = (): void => {
      desired = measureExtra(el);
      blocked = false;
      void pump();
    };
    const observer = new ResizeObserver(observe);
    observer.observe(el);
    observe();
    return (): void => {
      lifecycle.disposed = true;
      observer.disconnect();
    };
  }, [ref]);
}
