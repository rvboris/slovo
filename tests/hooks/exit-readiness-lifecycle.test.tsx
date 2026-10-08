import { StrictMode, useCallback } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../components/helpers";
import { useCorrectionEvents } from "../../src/hooks/useCorrectionEvents";
import { useExitGuard } from "../../src/hooks/useExitGuard";

const api = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), onCloseRequested: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: (): typeof api => api }));
const noop = (): void => undefined;
const clean = (): boolean => false;
const load = async (): Promise<void> => { await Promise.resolve(); };
function useWindowGuard(version: number): ReturnType<typeof useExitGuard> {
  const guard = useExitGuard(noop);
  const reload = useCallback(async (): Promise<void> => { await Promise.resolve(version); await load(); }, [version]);
  useCorrectionEvents({ applyExitRequest: guard.applyExitRequest, load: reload, probeReady: guard.probeReady, setConfirmClose: noop, setError: noop, shouldConfirmClose: clean });
  return guard;
}
beforeEach(() => {
  api.invoke.mockReset();
  api.listen.mockReset().mockResolvedValue(noop);
  api.onCloseRequested.mockReset().mockResolvedValue(noop);
});
it("ignores a numeric readiness reply after unmount", async () => {
  const ready = deferred<number | null>();
  api.invoke.mockReturnValue(ready.promise);
  const view = renderHook(() => useWindowGuard(0));
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith("correction_exit_ready"); });
  view.unmount();
  await act(async () => { ready.resolve(81); await ready.promise; });
  expect(api.invoke).not.toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 81 });
});
it("only the current StrictMode registration can establish readiness", async () => {
  const oldReady = deferred<number | null>();
  const currentReady = deferred<unknown>();
  api.invoke.mockReturnValueOnce(oldReady.promise).mockReturnValueOnce(currentReady.promise).mockResolvedValue(JSON.parse("null") as unknown);
  const view = renderHook(({ version }) => useWindowGuard(version), { initialProps: { version: 0 }, wrapper: StrictMode });
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith("correction_exit_ready"); });
  view.rerender({ version: 1 });
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledTimes(2); });
  await act(async () => { oldReady.resolve(82); await oldReady.promise; });
  expect(view.result.current.exitPending).toBe(false);
  act(() => { view.result.current.applyExitRequest(83); });
  expect(api.invoke).not.toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 83 });
  await act(async () => { currentReady.resolve(JSON.parse("null") as unknown); await currentReady.promise; });
  expect(api.invoke).toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 83 });
  expect(api.invoke).not.toHaveBeenCalledWith("resolve_exit_request", { decision: "approve", requestId: 82 });
});
