/* oxlint-disable max-classes-per-file, id-length, init-declarations, no-magic-numbers, no-unsafe-type-assertion, typescript/explicit-function-return-type, typescript/method-signature-style, promise/avoid-new, promise/param-names, promise/prefer-await-to-callbacks, sort-keys, class-methods-use-this, no-empty-function, require-await, prefer-destructuring, unicorn/no-null, typescript/no-unnecessary-type-assertion, typescript/no-confusing-void-expression, typescript/no-unsafe-member-access */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { useWindowAutoGrow } from "../../src/hooks/useWindowAutoGrow";

vi.mock("@tauri-apps/api/window", () => ({
  LogicalSize: class LogicalSize {
    public width: number;
    public height: number;
    public constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  },
  currentMonitor: vi.fn(),
  getCurrentWindow: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let height = 200;
let callback: ResizeObserverCallback;
let target: HTMLElement;
let setSize: ReturnType<typeof vi.fn>;
function signal(size: number): void {
  Object.defineProperty(target, "offsetHeight", { configurable: true, value: size });
  act(() => {
    callback([], {} as ResizeObserver);
  });
}
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  height = 200;
  target = document.createElement("div");
  vi.stubGlobal(
    "ResizeObserver",
    class Observer {
      public constructor(cb: ResizeObserverCallback) {
        callback = cb;
      }
      public observe(element: Element): void {
        target = element as HTMLElement;
      }
      public disconnect(): void {}
    },
  );
  setSize = vi.fn(async (size: { height: number }) => {
    height = size.height;
  });
  const reads = vi.fn(async () => ({ toLogical: () => ({ width: 400, height }) }));
  vi.mocked(getCurrentWindow).mockReturnValue({
    innerSize: reads,
    scaleFactor: vi.fn(async () => 1),
    setSize,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  vi.mocked(currentMonitor).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof currentMonitor>>,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});
function mount(strict = false): ReturnType<typeof renderHook> {
  return renderHook(() => useWindowAutoGrow({ current: target }), { reactStrictMode: strict });
}
describe("useWindowAutoGrow", () => {
  it("coalesces observations during delayed IPC and applies the newest content height afterward", async () => {
    const first = deferred<boolean>();
    height = 560;
    setSize.mockImplementationOnce(async (size: { height: number }) => {
      await first.promise;
      height = size.height;
    });
    const hook = mount();
    signal(578);
    await settle();
    signal(590);
    signal(560);
    first.resolve(true);
    await settle();
    expect(setSize).toHaveBeenCalledTimes(2);
    expect(setSize.mock.calls[0]?.[0].height).toBe(578);
    expect(setSize.mock.calls[0]?.[0].width).toBe(400);
    expect(setSize.mock.calls[1]?.[0].height).toBe(560);
    hook.unmount();
  });
  it("caps to work area and reconciles actual applied size", async () => {
    vi.mocked(currentMonitor).mockResolvedValue({ workArea: { size: { height: 230 } } } as never);
    setSize.mockImplementation(async (size: { height: number }) => {
      height = size.height - 5;
    });
    const hook = mount();
    signal(80);
    await settle();
    expect(setSize).toHaveBeenLastCalledWith(expect.objectContaining({ height: 230 }));
    hook.unmount();
  });
  it("cleans stale StrictMode effect and sets up a fresh observer", () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class Observer {
        public constructor(cb: ResizeObserverCallback) {
          callback = cb;
        }
        public observe(): void {}
        public disconnect(): void {
          disconnect();
        }
      },
    );
    const hook = mount(true);
    expect(disconnect).toHaveBeenCalled();
    hook.unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
  it("does not retry a rejected resize until another observation", async () => {
    setSize.mockRejectedValueOnce(new Error("denied"));
    const hook = mount();
    signal(40);
    await settle();
    expect(setSize).toHaveBeenCalledTimes(1);
    await settle();
    expect(setSize).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});
