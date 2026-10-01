import { mutateSettingData, withSettingLock } from '@/app/_authed/(settings)/_server/settings-cas'
import { getSettingImpl } from '@/app/_authed/(settings)/_server/settings-impl'

// An extension lock: the claim an agent holds on a local extension folder while
// it edits it, so a second writer is told instead of silently writing over the
// first. Keyed by extension folder, since a folder is what is edited. Advisory:
// anyone may take a lock over, and it lapses after a spell with no writes.

/**
 * How long a lock survives without a write before anyone else may take the
 * folder.
 *
 * A working session goes quiet for long stretches, so this is generous; but a
 * lock that outlives the work it belonged to is worse than none at all, since
 * the next person meets a refusal nobody can explain.
 */
export const LOCK_IDLE_MS = 30 * 60 * 1000

/** The settings row every extension lock on this instance lives in. */
export const LOCK_SETTING_ID = 'extension-dev-locks'

export interface ExtensionLock {
  /** The agent name the calling surface resolved — never one taken from arguments. */
  agent: string
  takenAt: number
  lastTouched: number
}

export type ExtensionLockMap = Record<string, ExtensionLock>

export type ExtensionLockOutcome = 'taken' | 'refreshed' | 'expired-taken' | 'taken-over' | 'refused'

export interface ExtensionLockDecision {
  outcome: ExtensionLockOutcome
  /** The lock that now stands — or, for a refusal, the one that blocked it. */
  lock: ExtensionLock
}

export interface ExtensionLockOptions {
  /** Take the folder even though someone else holds it. Always permitted. */
  takeover?: boolean
  idleMs?: number
  now?: number
}

/**
 * Decide who holds a folder next, given who holds it now.
 *
 * Pure: it reads a lock map and returns the next one, so every rule here is
 * testable without a store, a clock or a request. The persistence around it
 * exists only to read that map and write it back atomically.
 *
 * `next: null` means nothing should be written — the caller was refused, and a
 * refusal must not touch the holder's own timestamps, or being refused would
 * keep extending the lock that did the refusing.
 */
export function decideExtensionLock(
  locks: ExtensionLockMap,
  folder: string,
  agent: string,
  now: number,
  options: ExtensionLockOptions = {},
): { decision: ExtensionLockDecision; next: ExtensionLockMap | null } {
  const idleMs = options.idleMs ?? LOCK_IDLE_MS
  const held = locks[folder]

  const grant = (
    outcome: ExtensionLockOutcome,
    takenAt: number,
  ): { decision: ExtensionLockDecision; next: ExtensionLockMap } => {
    const lock: ExtensionLock = { agent, takenAt, lastTouched: now }
    return { decision: { outcome, lock }, next: { ...locks, [folder]: lock } }
  }

  if (!held) {
    return grant('taken', now)
  }
  // Holding it already: keep the original start time, push the idle clock out.
  if (held.agent === agent) {
    return grant('refreshed', held.takenAt)
  }
  if (now - held.lastTouched >= idleMs) {
    return grant('expired-taken', now)
  }
  if (options.takeover === true) {
    return grant('taken-over', now)
  }
  return { decision: { outcome: 'refused', lock: held }, next: null }
}

function minutesSince(from: number, now: number): number {
  return Math.max(0, Math.round((now - from) / 60_000))
}

/**
 * What to tell a caller whose write was refused.
 *
 * Names the holder and how long it has been quiet, because the only useful
 * next step is deciding whether that person is still working — and says how to
 * proceed regardless, since a lock must never be able to strand someone.
 */
export function extensionLockRefusalMessage(
  folder: string,
  held: ExtensionLock,
  now: number,
  takeoverHint: string,
): string {
  return (
    `"${folder}" is locked by ${held.agent} — taken ${minutesSince(held.takenAt, now)} min ago, ` +
    `last written to ${minutesSince(held.lastTouched, now)} min ago. Your change was NOT applied. ` +
    `The lock is advisory: ${takeoverHint} to take it over, or wait — it frees itself after ` +
    `${Math.round(LOCK_IDLE_MS / 60_000)} min without a write.`
  )
}

function readExtensionLocks(data: Record<string, unknown>): ExtensionLockMap {
  const value = data.locks
  return value && typeof value === 'object' ? (value as ExtensionLockMap) : {}
}

/**
 * Take, refresh or take over the lock on a folder, and report what happened.
 *
 * The read-decide-write runs under the shared settings mutex and compare-and-
 * swap, so two callers arriving together cannot both come away believing they
 * hold it.
 */
export async function claimExtensionLock(
  folder: string,
  agent: string,
  options: ExtensionLockOptions = {},
): Promise<ExtensionLockDecision> {
  const now = options.now ?? Date.now()
  let decided: ExtensionLockDecision | undefined
  await withSettingLock(LOCK_SETTING_ID, () =>
    mutateSettingData(LOCK_SETTING_ID, (data) => {
      const { decision, next } = decideExtensionLock(readExtensionLocks(data), folder, agent, now, options)
      decided = decision
      return next ? { ...data, locks: next } : data
    }),
  )
  if (!decided) {
    throw new Error('Lock decision was never reached')
  }
  return decided
}

/** Give up the lock on a folder. Releasing one held by somebody else does nothing. */
export async function releaseExtensionLock(folder: string, agent: string): Promise<boolean> {
  let released = false
  await withSettingLock(LOCK_SETTING_ID, () =>
    mutateSettingData(LOCK_SETTING_ID, (data) => {
      const locks = readExtensionLocks(data)
      if (locks[folder]?.agent !== agent) {
        return data
      }
      released = true
      const next = { ...locks }
      delete next[folder]
      return { ...data, locks: next }
    }),
  )
  return released
}

/** Who holds what right now, with lapsed locks already dropped. */
export async function readActiveExtensionLocks(
  now: number = Date.now(),
  idleMs: number = LOCK_IDLE_MS,
): Promise<ExtensionLockMap> {
  const row = await getSettingImpl(LOCK_SETTING_ID)
  const locks = readExtensionLocks(row?.data ?? {})
  const active: ExtensionLockMap = {}
  for (const [folder, lock] of Object.entries(locks)) {
    if (now - lock.lastTouched < idleMs) {
      active[folder] = lock
    }
  }
  return active
}
