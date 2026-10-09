import { LogicalSize, currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import type { RefObject } from "react";
import { useEffect } from "react";

const MINIMUM_HEIGHT = 560;
const SIZE_EPSILON = 0.5;

/* oxlint-disable max-statements, max-lines-per-function, max-depth */

/** Grows/shrinks the window to fit all content, preserving its width. */
export function useWindowAutoGrow(ref: RefObject<HTMLElement | null>): void {
  useEffect((): (() => void) | undefined => {
    const el = ref.current;
    if (el === null) { return undefined; }

    const win = getCurrentWindow();
    const lifecycle: { disposed: boolean } = { disposed: false };
    let running = false;
    let blocked = false;
    let desired = MINIMUM_HEIGHT;
    let applied = MINIMUM_HEIGHT;
    let firstMeasure = true;

    const pump = async (): Promise<void> => {
      if (running || lifecycle.disposed || blocked) { return; }
      running = true;
      try {
        if (desired !== applied || firstMeasure) {
          const target = desired;
          try {
            const [size, scale, monitor] = await Promise.all([
              win.innerSize(), win.scaleFactor(), currentMonitor(),
            ]);
            const { width, height } = size.toLogical(scale);
            firstMeasure = false;
            let bounded = Math.max(MINIMUM_HEIGHT, target);
            if (monitor !== null) {
              const maxHeight = monitor.workArea.size.height / scale;
              bounded = Math.min(bounded, maxHeight);
            }
            const actualTarget = bounded;
            if (Math.abs(height - actualTarget) >= SIZE_EPSILON) {
              await win.setSize(new LogicalSize(width, actualTarget));
            }
            // Capped targets settle: never re-pump merely because the uncapped request was larger.
            applied = target;
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
      desired = Math.max(MINIMUM_HEIGHT, el.offsetHeight);
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
