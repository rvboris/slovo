import { act } from "@testing-library/react";
import { vi } from "vitest";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value | PromiseLike<Value>) => void;
  reject: (reason: unknown) => void;
}
function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, reject, resolve };
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
interface Event {
  event: string;
  id: number;
  payload: unknown;
}
interface EventBus {
  dispose: ReturnType<typeof vi.fn<() => void>>;
  listen: ReturnType<
    typeof vi.fn<(name: string, handler: (event: Event) => void) => Promise<() => void>>
  >;
  send: (name: string, payload: unknown) => void;
}
function events(): EventBus {
  const handlers = new Map<string, (event: Event) => void>();
  const dispose = vi.fn<() => void>();
  const listen = vi.fn(
    async (name: string, handler: (event: Event) => void): Promise<() => void> => {
      handlers.set(name, handler);
      await Promise.resolve();
      return (): void => {
        handlers.delete(name);
        dispose();
      };
    },
  );
  function send(name: string, payload: unknown): void {
    act(() => {
      handlers.get(name)?.({ event: name, id: 1, payload });
    });
  }
  return { dispose, listen, send };
}
export { deferred, events, flush };
