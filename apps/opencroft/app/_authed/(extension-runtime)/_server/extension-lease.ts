import { mutateSettingData, withSettingLock } from '@/app/_authed/(settings)/_server/settings-cas'
import { getSettingImpl } from '@/app/_authed/(settings)/_server/settings-impl'

/**
 * How long a lease survives without a write before anyone else may take the
 * directory.
 *
 * A working session goes quiet for long stretches, so this is generous; but a
 * lease that outlives the work it belonged to is worse than none at all, since
 * the next person meets a refusal nobody can explain.
 */
export const LEASE_IDLE_MS = 30 * 60 * 1000

/** The settings row every lease on this instance lives in. */
export const LEASE_SETTING_ID = 'extension-dev-leases'

export interface ExtensionLease {
  /** The agent name the calling surface resolved — never one taken from arguments. */
  agent: string
  takenAt: number
  lastTouched: number
}

export type LeaseMap = Record<string, ExtensionLease>

export type LeaseOutcome = 'taken' | 'refreshed' | 'expired-taken' | 'taken-over' | 'refused'

export interface LeaseDecision {
  outcome: LeaseOutcome
  /** The lease that now stands — or, for a refusal, the one that blocked it. */
  lease: ExtensionLease
}

export interface LeaseOptions {
  /** Take the directory even though someone else holds it. Always permitted. */
  takeover?: boolean
  idleMs?: number
  now?: number
}

/**
 * Decide who holds a directory next, given who holds it now.
 *
 * Pure: it reads a lease map and returns the next one, so every rule here is
 * testable without a store, a clock or a request. The persistence around it
 * exists only to read that map and write it back atomically.
 *
 * `next: null` means nothing should be written — the caller was refused, and a
 * refusal must not touch the holder's own timestamps, or being refused would
 * keep extending the lease that did the refusing.
 */
export function decideLease(
  leases: LeaseMap,
  slug: string,
  agent: string,
  now: number,
  options: LeaseOptions = {},
): { decision: LeaseDecision; next: LeaseMap | null } {
  const idleMs = options.idleMs ?? LEASE_IDLE_MS
  const held = leases[slug]

  const grant = (outcome: LeaseOutcome, takenAt: number): { decision: LeaseDecision; next: LeaseMap } => {
    const lease: ExtensionLease = { agent, takenAt, lastTouched: now }
    return { decision: { outcome, lease }, next: { ...leases, [slug]: lease } }
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
  return { decision: { outcome: 'refused', lease: held }, next: null }
}

function minutesSince(from: number, now: number): number {
  return Math.max(0, Math.round((now - from) / 60_000))
}

/**
 * What to tell a caller whose write was refused.
 *
 * Names the holder and how long it has been quiet, because the only useful
 * next step is deciding whether that person is still working — and says how to
 * proceed regardless, since a lease must never be able to strand someone.
 */
export function leaseRefusalMessage(slug: string, held: ExtensionLease, now: number, takeoverHint: string): string {
  return (
    `"${slug}" is currently held by ${held.agent} — taken ${minutesSince(held.takenAt, now)} min ago, ` +
    `last written to ${minutesSince(held.lastTouched, now)} min ago. Your change was NOT applied. ` +
    `This is advisory, not a lock: ${takeoverHint} to take it over, or wait — a lease frees itself after ` +
    `${Math.round(LEASE_IDLE_MS / 60_000)} min without a write.`
  )
}

function readLeases(data: Record<string, unknown>): LeaseMap {
  const value = data.leases
  return value && typeof value === 'object' ? (value as LeaseMap) : {}
}

/**
 * Claim, refresh or take over a directory, and report what happened.
 *
 * The read-decide-write runs under the shared settings mutex and compare-and-
 * swap, so two callers arriving together cannot both come away believing they
 * hold it.
 */
export async function claimExtensionLease(
  slug: string,
  agent: string,
  options: LeaseOptions = {},
): Promise<LeaseDecision> {
  const now = options.now ?? Date.now()
  let decided: LeaseDecision | undefined
  await withSettingLock(LEASE_SETTING_ID, () =>
    mutateSettingData(LEASE_SETTING_ID, (data) => {
      const { decision, next } = decideLease(readLeases(data), slug, agent, now, options)
      decided = decision
      return next ? { ...data, leases: next } : data
    }),
  )
  if (!decided) {
    throw new Error('Lease decision was never reached')
  }
  return decided
}

/** Give up a directory. Releasing one held by somebody else does nothing. */
export async function releaseExtensionLease(slug: string, agent: string): Promise<boolean> {
  let released = false
  await withSettingLock(LEASE_SETTING_ID, () =>
    mutateSettingData(LEASE_SETTING_ID, (data) => {
      const leases = readLeases(data)
      if (leases[slug]?.agent !== agent) {
        return data
      }
      released = true
      const next = { ...leases }
      delete next[slug]
      return { ...data, leases: next }
    }),
  )
  return released
}

/** Who holds what right now, with expired leases already dropped. */
export async function readActiveLeases(now: number = Date.now(), idleMs: number = LEASE_IDLE_MS): Promise<LeaseMap> {
  const row = await getSettingImpl(LEASE_SETTING_ID)
  const leases = readLeases(row?.data ?? {})
  const active: LeaseMap = {}
  for (const [slug, lease] of Object.entries(leases)) {
    if (now - lease.lastTouched < idleMs) {
      active[slug] = lease
    }
  }
  return active
}
