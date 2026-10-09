import type { Settings } from "../../src/lib/types";

const settings: Settings = {
  hotkey: "Ctrl+Space", inputDevice: null, llmApiKey: null, llmModel: null, llmPrompt: null, llmServerUrl: null, serverUrl: "http://localhost:8072", triggerType: "toggle",
};

interface Deferred<Value> { promise: Promise<Value>; resolve: (value: Value | PromiseLike<Value>) => void; reject: (reason?: unknown) => void }

function deferred<Value>(): Deferred<Value> {
  let resolveFunction!: (value: Value | PromiseLike<Value>) => void;
  let rejectFunction!: (reason?: unknown) => void;
  // oxlint-disable-next-line promise/avoid-new -- controlled deferred fixture is required to drive deterministic concurrency tests.
  const promise = new Promise<Value>((resolve, reject) => {
    resolveFunction = resolve;
    rejectFunction = reject;
  });
  return { promise, reject: rejectFunction, resolve: resolveFunction };
}

export { deferred, settings };
