import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, flush } from './harness';
import { invoke } from '@tauri-apps/api/core';
import { useServerAvailability } from '../../src/hooks/useServerAvailability';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const ipc = vi.mocked(invoke);
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
describe('server availability', () => {
  it('checks enabled servers, treats null as reachable, polls and cleans interval', async () => {
    ipc.mockResolvedValue(null); const { result, unmount } = renderHook(() => useServerAvailability('http://localhost:8072', true)); await flush(); expect(result.current.status).toBe('available');
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); expect(ipc).toHaveBeenCalledTimes(2); unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('reports false/rejection and suppresses checks for invalid or disabled URLs', async () => {
    ipc.mockResolvedValueOnce(false).mockRejectedValueOnce('offline'); const { result } = renderHook(() => useServerAvailability('http://host', false)); expect(ipc).not.toHaveBeenCalled();
    await act(async () => { await result.current.check('http://host'); }); expect(result.current.status).toBe('unavailable');
    await act(async () => { await result.current.check('http://host'); await result.current.check('file:///bad'); }); expect(result.current.status).toBe('idle'); expect(ipc).toHaveBeenCalledTimes(2);
  });
  it('ignores old responses after URL change, invalidation, and unmount', async () => {
    const pending = deferred<boolean>(); ipc.mockReturnValueOnce(pending.promise).mockResolvedValue(true);
    const { result, rerender, unmount } = renderHook(({ url }) => useServerAvailability(url, true), { initialProps: { url: 'http://old' } });
    rerender({ url: 'http://new' }); expect(result.current.status).toBe('idle');
    await act(async () => { await result.current.check('http://new'); pending.resolve(false); }); expect(result.current.status).toBe('available');
    act(() => { result.current.invalidate(); }); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); expect(result.current.status).toBe('idle'); expect(ipc).toHaveBeenCalledTimes(2);
    const last = deferred<boolean>(); ipc.mockReturnValueOnce(last.promise); let request!: Promise<void>; act(() => { request = result.current.check('http://new'); }); unmount(); await act(async () => { last.resolve(true); await request; }); expect(vi.getTimerCount()).toBe(0);
  });
});
