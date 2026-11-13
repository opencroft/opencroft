// A browser's own Recent, from before Recent was kept in the account: the
// ids it stored, newest first, read once on the browser and imported by the
// server. Dependency-free, so both sides read the same rules from here.

/** The most ids a browser ever kept, and so the most one import may send. */
export const LEGACY_RECENT_THREADS_MAX = 10

/**
 * The ids a stored value holds, newest first. Anything else in storage --
 * another shape, a hand edit, a value from a future build -- reads as an
 * empty list rather than failing the page that shows it.
 */
export function parseRecentThreadIds(raw: string | null): string[] {
  if (!raw) {
    return []
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) {
    return []
  }
  const ids = value.filter((id): id is string => typeof id === 'string' && id.length > 0)
  return [...new Set(ids)].slice(0, LEGACY_RECENT_THREADS_MAX)
}
