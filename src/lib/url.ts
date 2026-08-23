/**
 * Returns the trimmed URL when it is a syntactically valid http(s) URL,
 * otherwise null. Empty or whitespace-only input yields null.
 *
 * Single source of truth for server-URL validation: the settings field, the
 * availability checker, and the save scheduler must agree on what counts as
 * a valid transcription server address.
 */
export function normalizeHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed;
}
