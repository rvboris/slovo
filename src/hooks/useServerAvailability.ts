import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type ServerAvailability =
  | "idle"
  | "checking"
  | "available"
  | "unavailable";

const CHECK_INTERVAL_MS = 30_000;

function normalizeValidUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function useServerAvailability(url: string, enabled: boolean) {
  const [result, setResult] = useState<{
    status: ServerAvailability;
    url: string;
  }>({ status: "idle", url: "" });
  const currentUrlRef = useRef(url);
  const requestRevisionRef = useRef(0);
  const checksSuspendedRef = useRef(false);
  const mountedRef = useRef(false);
  currentUrlRef.current = url;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRevisionRef.current += 1;
    };
  }, []);

  const invalidate = useCallback(() => {
    checksSuspendedRef.current = true;
    requestRevisionRef.current += 1;
    if (mountedRef.current) setResult({ status: "idle", url: "" });
  }, []);

  const check = useCallback(async (value: string): Promise<void> => {
    const normalizedUrl = normalizeValidUrl(value);
    const revision = ++requestRevisionRef.current;

    if (!normalizedUrl) {
      if (mountedRef.current) setResult({ status: "idle", url: "" });
      return;
    }

    checksSuspendedRef.current = false;
    setResult({ status: "checking", url: normalizedUrl });

    try {
      // The command resolves (available) or rejects (unavailable); it carries
      // no payload, so the outcome comes from the promise state alone.
      await invoke<void>("check_server_url", { serverUrl: normalizedUrl });
      if (
        mountedRef.current &&
        revision === requestRevisionRef.current &&
        normalizeValidUrl(currentUrlRef.current) === normalizedUrl
      ) {
        setResult({ status: "available", url: normalizedUrl });
      }
    } catch {
      if (
        mountedRef.current &&
        revision === requestRevisionRef.current &&
        normalizeValidUrl(currentUrlRef.current) === normalizedUrl
      ) {
        setResult({ status: "unavailable", url: normalizedUrl });
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      invalidate();
      return;
    }

    void check(currentUrlRef.current);
    // Skip periodic checks while the window is hidden (no UI to update, no
    // reason to hit the network); re-check as soon as it becomes visible.
    const interval = window.setInterval(() => {
      if (!checksSuspendedRef.current && !document.hidden) {
        void check(currentUrlRef.current);
      }
    }, CHECK_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden && !checksSuspendedRef.current) {
        void check(currentUrlRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, check, invalidate]);

  const currentNormalizedUrl = normalizeValidUrl(url);
  const status =
    currentNormalizedUrl && result.url === currentNormalizedUrl
      ? result.status
      : "idle";

  return { status, check, invalidate };
}
