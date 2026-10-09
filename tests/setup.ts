import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// JSDOM lacks ResizeObserver; useWindowAutoGrow relies on it.
class ResizeObserverStub implements ResizeObserver {
  public observe(_target: Element): void { void this.observed; }
  public unobserve(_target: Element): void { void this.observed; }
  public disconnect(): void { this.observed = false; }
  private observed = false;
}
globalThis.ResizeObserver = ResizeObserverStub;
