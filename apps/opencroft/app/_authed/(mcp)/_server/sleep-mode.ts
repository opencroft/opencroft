import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * SLEEP MODE — hold every agent delivery, wake later.
 *
 * While asleep, agents keep working and anything sent to them enqueues (and
 * persists) exactly as normal — but nothing is drained to any agent until the
 * instance wakes. The gate itself lives in agent-client
 * (`shouldHoldDelivery`, consulted at the top of every queue drain); this
 * module is only the policy: where the flag lives and who gets told when it
 * changes.
 *
 * WHY A MARKER FILE AND NOT A SETTINGS ROW
 *
 * Several instances can share one database, so a settings row flipped on one
 * instance would put the other to sleep too, causing the very
 * outage it exists to prevent. The marker sits on the instance's OWN data
 * volume (same pattern and directory as the MCP auth kill switch), which is
 * per-instance by construction. It also survives a restart by design: an
 * instance switched to Sleep Mode boots back up asleep, which is the whole
 * point — the restart happens while the queue is held, and the held queue is
 * durable for the same restart.
 *
 * The file can be created or removed out-of-band (from the workspace bind
 * mount, even against a container that will not start). Out-of-band changes
 * converge without a restart because every read is a short-cached file check
 * with change detection: the next drain attempt or settings-page poll sees
 * the new value, and a detected change notifies subscribers — which is what
 * resumes delivery after an out-of-band wake. Known property: with no
 * settings page open and no new traffic, an out-of-band wake converges only
 * on the NEXT read of the flag — the marker is polled by readers, not
 * watched. The in-app toggle is immediate.
 */

// The data volume, matching how packages/db resolves PGLITE_PATH and how the
// MCP auth kill switch resolves its own file.
const DATA_DIR = process.env.OPENCROFT_DATA_DIR ?? path.join(process.cwd(), 'data')
export const SLEEP_MARKER_PATH = path.join(DATA_DIR, 'sleep-mode-on')

// Short, like the kill switch's: this is how long an out-of-band toggle can
// go unnoticed, so it is tuned for the incident, not the happy path.
const CACHE_MS = 2000

let cachedAt = 0
let cachedPresent = false

function markerPresent(): boolean {
  const now = Date.now()
  if (now - cachedAt < CACHE_MS) {
    return cachedPresent
  }
  cachedAt = now
  try {
    cachedPresent = existsSync(SLEEP_MARKER_PATH)
  } catch {
    // An unreadable data directory must not put the instance to sleep by
    // itself. Awake is the direction that keeps messages flowing.
    cachedPresent = false
  }
  return cachedPresent
}

type SleepListener = (enabled: boolean) => void
const listeners = new Set<SleepListener>()

let lastEffective: boolean | null = null

// isSleepMode() is an EFFECTFUL READ: a detected wake fires listeners — and
// one of those calls resumeDelivery() — from inside whatever call site did the
// reading, including drainQueue's own gate check. That is safe today only
// because dispatchRun mutates the queue synchronously before its first await,
// so a re-entrant drain and the outer one cannot double-deliver the same run.
// If dispatch ever becomes async before the queue mutation, this notification
// must move out of the read path (e.g. onto a timer).
function detectChange(value: boolean): void {
  if (lastEffective === value) {
    return
  }
  const first = lastEffective === null
  lastEffective = value
  // The initial read is state, not a transition — nobody needs waking for it.
  if (first) {
    return
  }
  for (const listener of listeners) {
    try {
      listener(value)
    } catch (error) {
      // A failing observer must not leave the flag half-applied for the others.
      console.error('Sleep mode listener failed', error)
    }
  }
}

/** Whether the instance is asleep right now. Cheap; consulted per drain. */
export function isSleepMode(): boolean {
  const value = markerPresent()
  detectChange(value)
  return value
}

/** Observe effective sleep changes. Returns an unsubscribe. */
export function subscribeSleepMode(listener: SleepListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Toggle sleep mode. Persists (a restart comes back in the same state). */
export function setSleepMode(value: boolean): void {
  if (value) {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(SLEEP_MARKER_PATH, `asleep since ${new Date().toISOString()}\n`)
  } else {
    rmSync(SLEEP_MARKER_PATH, { force: true })
  }
  cachedAt = 0
  isSleepMode()
}

/** The effective state and where the flag lives, for the settings surface. */
export function getSleepModeInfo(): { enabled: boolean; markerPath: string } {
  return { enabled: isSleepMode(), markerPath: SLEEP_MARKER_PATH }
}

/**
 * Testing seam — the cache would otherwise hide a file created mid-test.
 * Clears the FILE cache only: the transition memory is state, not cache, and
 * wiping it would turn the next read into "initial state" and swallow the
 * very notification an out-of-band change owes its subscribers. A real
 * restart does wipe it — and a boot read is genuinely initial state, which is
 * why boot never fires listeners and the boot log line exists instead.
 */
export function resetSleepModeCache(): void {
  cachedAt = 0
  cachedPresent = false
}

// A restart into a held queue is the feature working, but it must never be
// silent: this line is the boot-time half of the audit page's banner.
if (isSleepMode()) {
  console.warn(
    `[sleep-mode] This instance is ASLEEP: agent deliveries are held. Remove ${SLEEP_MARKER_PATH} or use the MCP audit settings page to wake it.`,
  )
}
