import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ServerAvailability = "idle" | "checking" | "available" | "unavailable";
interface Result { readonly status: ServerAvailability; readonly url: string }
const CHECK_INTERVAL_MS = 30_000;
const INITIAL_REVISION = 0;
function normalizeValidUrl(value: string): string | null {
  try {
    const trimmed = value.trim();
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") { return trimmed; }
  } catch { return null; }
  return null;
}
async function checkAvailability(url: string): Promise<ServerAvailability> {
  try {
    const available = await invoke<boolean | null>("check_server_url", { serverUrl: url });
    if (available === false) { return "unavailable"; }
    return "available";
  } catch { return "unavailable"; }
}
async function publishAvailability(url: string, revision: number, options: Readonly<{ current: Readonly<{ current: Readonly<{ mounted: boolean; revision: number; url: string }> }>; setResult: (result: Readonly<Result>) => void }>): Promise<void> {
  const status = await checkAvailability(url);
  const lifecycle = options.current.current;
  if (lifecycle.mounted && lifecycle.revision === revision && normalizeValidUrl(lifecycle.url) === url) { options.setResult({ status, url }); }
}
function clearResult(mounted: boolean, setResult: (result: Readonly<Result>) => void): void {
  if (mounted) { setResult({ status: "idle", url: "" }); }
}
function useServerCheck(url: string): { check: (value: string) => Promise<void>; invalidate: () => void; result: Result; suspended: { current: boolean } } {
  const [result, setResult] = useState<Result>({ status: "idle", url: "" });
  const current = useRef({ mounted: false, revision: INITIAL_REVISION, url });
  const suspended = useRef(false);
  useEffect((): void => { current.current.url = url; }, [url]);
  useEffect(() => {
    const lifecycle = current.current;
    lifecycle.mounted = true;
    return (): void => { lifecycle.mounted = false; lifecycle.revision += 1; };
  }, []);
  const invalidate = useCallback((): void => {
    suspended.current = true;
    current.current.revision += 1;
    if (current.current.mounted) { setResult({ status: "idle", url: "" }); }
  }, []);
  const check = useCallback(async (value: string): Promise<void> => {
    const normalized = normalizeValidUrl(value);
    current.current.revision += 1;
    const { revision } = current.current;
    if (normalized === null) { clearResult(current.current.mounted, setResult); return; }
    suspended.current = false;
    setResult({ status: "checking", url: normalized });
    await publishAvailability(normalized, revision, { current, setResult });
  }, []);
  return { check, invalidate, result, suspended };
}
function useServerAvailability(url: string, enabled: boolean): { check: (value: string) => Promise<void>; invalidate: () => void; status: ServerAvailability } {
  const { check, invalidate, result, suspended } = useServerCheck(url);
  const currentUrl = useRef(url);
  useEffect((): void => { currentUrl.current = url; }, [url]);
  useEffect(() => {
    let interval: ReturnType<typeof globalThis.setInterval> | null = null;
    if (enabled) {
      void check(currentUrl.current);
      interval = globalThis.setInterval((): void => { if (!suspended.current) { void check(currentUrl.current); } }, CHECK_INTERVAL_MS);
    } else { invalidate(); }
    return (): void => { if (interval !== null) { globalThis.clearInterval(interval); } };
  }, [enabled, check, invalidate, suspended]);
  let status: ServerAvailability = "idle";
  if (normalizeValidUrl(url) !== null && result.url === normalizeValidUrl(url)) { ({ status } = result); }
  return { check, invalidate, status };
}
export { type ServerAvailability, useServerAvailability };
