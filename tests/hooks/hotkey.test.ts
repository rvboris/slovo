import { act, fireEvent, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, flush } from './harness';
import type { RenderHookResult } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { useHotkey } from '../../src/hooks/useHotkey';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const ipc = vi.mocked(invoke); const onError = vi.fn<(message: string) => void>(); const onSave = vi.fn<(hotkey: string) => void>();
beforeEach(() => { vi.clearAllMocks(); ipc.mockResolvedValue(null); });
function mount(enabled = true): RenderHookResult<ReturnType<typeof useHotkey>, undefined> { return renderHook(() => useHotkey({ enabled, hotkey: 'Ctrl+Space', onError, onSave })); }
describe('hotkey capture', () => {
  it.each([false, true])('cancels blur synchronously with pending=%s', async (pending) => {
    const view = mount(); await flush();
    const ack = deferred<string>();
    if (pending) { ipc.mockReturnValueOnce(ack.promise); }
    act(() => { view.result.current.handleClick(); }); await flush();
    act(() => {
      globalThis.dispatchEvent(new Event('blur'));
      fireEvent.keyDown(globalThis.document, { code: 'KeyA', ctrlKey: true, key: 'a' });
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(view.result.current.isCapturing).toBe(false);
    expect(view.result.current.isStartingCapture).toBe(false);
    await act(async () => { ack.resolve('ack'); await ack.promise; });
    expect(view.result.current.isCapturing).toBe(false);
  });

  it.each(['recording', 'transcribing', 'correcting'])('cancels when eligibility is lost for %s', async () => {
    const view = renderHook(({ enabled }) => useHotkey({ enabled, hotkey: 'Ctrl+Space', onError, onSave }), { initialProps: { enabled: true } });
    await flush();
    act(() => { view.result.current.handleClick(); }); await flush();
    view.rerender({ enabled: false });
    fireEvent.keyDown(globalThis.document, { code: 'KeyA', ctrlKey: true, key: 'a' });
    expect(view.result.current.isCapturing).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('invalidates a pending acquisition on eligibility loss', async () => {
    const view = renderHook(({ enabled }) => useHotkey({ enabled, hotkey: 'Ctrl+Space', onError, onSave }), { initialProps: { enabled: true } });
    await flush();
    const ack = deferred<string>(); ipc.mockReturnValueOnce(ack.promise);
    act(() => { view.result.current.handleClick(); });
    view.rerender({ enabled: false });
    expect(view.result.current.isStartingCapture).toBe(false);
    await act(async () => { ack.resolve('ack'); await ack.promise; });
    expect(view.result.current.isCapturing).toBe(false);
    fireEvent.keyDown(globalThis.document, { code: 'KeyA', ctrlKey: true, key: 'a' });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps capture B active after cancelled pending A acknowledges', async () => {
    const view = mount(); await flush();
    const ack = deferred<string>(); ipc.mockReturnValueOnce(ack.promise);
    act(() => { view.result.current.handleClick(); }); await flush();
    act(() => { globalThis.dispatchEvent(new Event('blur')); });
    act(() => { view.result.current.handleClick(); }); await flush();
    expect(view.result.current.isCapturing).toBe(true);
    await act(async () => { ack.resolve('ack'); await ack.promise; });
    expect(view.result.current.isCapturing).toBe(true);
    fireEvent.keyDown(globalThis.document, { code: 'KeyB', ctrlKey: true, key: 'b' });
    expect(onSave).toHaveBeenCalledExactlyOnceWith('Ctrl+KeyB');
  });
  it('resets backend on mount, captures a physical chord, and releases backend and keyboard listener', async () => {
    const { result, unmount } = mount(); await flush();
    expect(ipc).toHaveBeenCalledWith('set_hotkey_capture_active', expect.objectContaining({ active: false }));
    act(() => { result.current.handleClick(); }); await flush(); expect(result.current.isCapturing).toBe(true);
    act(() => { fireEvent.keyDown(globalThis.document, { code: 'ControlLeft', ctrlKey: true, key: 'Control' }); });
    expect(result.current.captureMessage).toBe('Добавьте клавишу…');
    act(() => { fireEvent.keyDown(globalThis.document, { code: 'KeyA', ctrlKey: true, key: 'ф' }); }); await flush();
    expect(onSave).toHaveBeenCalledWith('Ctrl+KeyA'); expect(result.current.isCapturing).toBe(false);
    unmount(); fireEvent.keyDown(globalThis.document, { code: 'KeyB', ctrlKey: true, key: 'b' }); expect(onSave).toHaveBeenCalledTimes(1);
    expect(ipc).toHaveBeenLastCalledWith('set_hotkey_capture_active', expect.objectContaining({ active: false }));
  });
  it('does not start when disabled and cancels on Escape or a second click', async () => {
    const disabled = mount(false); act(() => { disabled.result.current.handleClick(); }); await flush(); expect(ipc).toHaveBeenCalledTimes(1); disabled.unmount();
    const { result } = mount(); act(() => { result.current.handleClick(); }); await flush();
    act(() => { fireEvent.keyDown(globalThis.document, { code: 'Escape', key: 'Escape' }); }); expect(result.current.isCapturing).toBe(false);
    act(() => { result.current.handleClick(); }); await flush(); act(() => { result.current.handleClick(); }); expect(result.current.isCapturing).toBe(false); expect(onSave).not.toHaveBeenCalled();
  });
  it('compensates rejected activation and allows another attempt', async () => {
    ipc.mockImplementation(async (_command, args) => { if (args && typeof args === 'object' && 'active' in args && args.active === true) { throw new Error('denied'); } await flush(); });
    const { result } = mount(); act(() => { result.current.handleClick(); }); await flush();
    expect(onError).toHaveBeenCalledWith('denied'); expect(result.current.isStartingCapture).toBe(false);
    expect(ipc).toHaveBeenLastCalledWith('set_hotkey_capture_active', expect.objectContaining({ active: false }));
    ipc.mockResolvedValue(null); act(() => { result.current.handleClick(); }); await flush(); expect(result.current.isCapturing).toBe(true);
  });
  it('uses newer cleanup tokens and compensates activation resolving after unmount', async () => {
    const pending = deferred<null>(); ipc.mockResolvedValueOnce(null).mockReturnValueOnce(pending.promise).mockResolvedValue(null);
    const { result, unmount } = mount(); act(() => { result.current.handleClick(); }); await flush();
    const activation = ipc.mock.calls[1]?.[1];
    if (!activation || typeof activation !== 'object' || !('token' in activation) || typeof activation.token !== 'number') { throw new Error('Missing activation token'); }
    unmount();
    const cleanup = ipc.mock.calls[2]?.[1];
    if (!cleanup || typeof cleanup !== 'object' || !('token' in cleanup) || typeof cleanup.token !== 'number') { throw new Error('Missing cleanup token'); }
    expect(cleanup.token).toBeGreaterThan(activation.token);
    await act(async () => { pending.resolve(null); await flush(); });
    expect(ipc).toHaveBeenLastCalledWith('set_hotkey_capture_active', { active: false, token: activation.token }); expect(onError).not.toHaveBeenCalled();
  });
  it('reports explicit release failure without leaving capture UI active', async () => {
    const { result } = mount(); act(() => { result.current.handleClick(); }); await flush();
    ipc.mockRejectedValueOnce('release failed'); act(() => { result.current.handleClick(); }); await flush();
    expect(result.current.isCapturing).toBe(false); expect(onError).toHaveBeenCalledWith('release failed');
  });
});
