/**
 * YOLO_MODE — the "no gate anywhere" switch.
 *
 * Two things happen while it is on, and they are separate mechanisms that this
 * flag deliberately ties together:
 *   1. MCP tool calls are allowed without approval (see resolvePermission).
 *   2. Every agent session is forced into its bypass permission mode and cannot
 *      be moved off it (see the agent layer's YOLO mode enforcement, which
 *      subscribes below). The mode each session was in is restored when YOLO is
 *      turned back off.
 *
 * Controlled by:
 *   1. OPENCROFT_YOLO_MODE env var (default: false) — read at startup
 *   2. Runtime toggle via setYoloMode() — resets on process restart
 */

let runtimeOverride: boolean | null = null

const ENV_YOLO = process.env.OPENCROFT_YOLO_MODE === 'true'

/** Check if YOLO mode is active. */
export function isYoloMode(): boolean {
  return runtimeOverride ?? ENV_YOLO
}

// Notified whenever the effective value CHANGES, so a subscriber never has to
// diff it themselves — and never re-runs enforcement for a no-op write. Kept as
// a plain in-memory set for the same reason the override itself is in memory:
// the runtime toggle does not survive a restart, so neither should anything
// derived from it.
type YoloListener = (enabled: boolean) => void
const listeners = new Set<YoloListener>()

/** Observe effective YOLO changes. Returns an unsubscribe. */
export function subscribeYoloMode(listener: YoloListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Toggle YOLO mode at runtime (not persisted). */
export function setYoloMode(value: boolean): void {
  const before = isYoloMode()
  runtimeOverride = value
  const after = isYoloMode()
  if (after === before) {
    return
  }
  for (const listener of listeners) {
    try {
      listener(after)
    } catch (error) {
      // A failing observer must not leave the flag half-applied for the others.
      console.error('YOLO mode listener failed', error)
    }
  }
}

/** Get the effective YOLO mode and its source. */
export function getYoloModeInfo(): { enabled: boolean; source: 'env' | 'runtime' } {
  if (runtimeOverride !== null) {
    return { enabled: runtimeOverride, source: 'runtime' }
  }
  return { enabled: ENV_YOLO, source: 'env' }
}
