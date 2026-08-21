// Presence: how often an agent reads its queue.
//
// Kept apart from the engine because all of it is arithmetic over a queue and a
// setting, and none of it needs a session, a connection or a timer. That makes
// the rule testable at the only place it is decided, and leaves the engine with
// just the two things it is actually responsible for: asking, and waiting.

import type { Presence, QueuedPrompt } from './types'

/**
 * What a session reads at until told otherwise.
 *
 * Realtime is the default because it is what every session did before Presence
 * existed: a new setting must not change the behaviour of anything that has not
 * asked for it.
 */
export const DEFAULT_PRESENCE: Presence = { kind: 'realtime' }

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** The `minutes` cadence is a range, not a value — see presenceWindowMs. */
export const MINUTES_WINDOW_MIN_MS = 1 * MINUTE_MS
export const MINUTES_WINDOW_MAX_MS = 3 * MINUTE_MS

/**
 * How long the oldest waiting message must have waited before the queue goes.
 *
 * `minutes` is deliberately random within its range, and the caller is expected
 * to roll it ONCE per waiting period and hold the result. Re-rolling on every
 * check would make the deadline move under its own timer: a queue could be due
 * at one instant and not due a moment later, and the wait would end whenever
 * the dice happened to agree rather than after the interval anyone intended.
 *
 * `custom` is clamped at zero rather than rejected. A negative interval has an
 * unambiguous meaning here — no waiting — and refusing it would turn a bad
 * setting into a message that never arrives, which is the worse failure.
 */
export function presenceWindowMs(presence: Presence, roll: () => number = Math.random): number {
  switch (presence.kind) {
    case 'realtime':
      return 0
    case 'minutes':
      return MINUTES_WINDOW_MIN_MS + roll() * (MINUTES_WINDOW_MAX_MS - MINUTES_WINDOW_MIN_MS)
    case 'hourly':
      return HOUR_MS
    case 'daily':
      return DAY_MS
    case 'custom':
      return Math.max(0, presence.intervalMs)
  }
}

/**
 * When the oldest waiting MESSAGE was sent, or null if nothing is waiting.
 *
 * Messages only. A system entry is not gated by Presence and never opens a
 * window for the messages behind it — compaction requested now must not wait an
 * hour because the reading cadence is hourly, and it must not drag the
 * conversation along with it either.
 *
 * The oldest, not the newest: the question is how long anyone has been waiting
 * for a reply. Measuring from the newest would let a steady trickle of messages
 * hold the queue shut indefinitely, which is the opposite of what a reading
 * cadence is for.
 *
 * An unparseable timestamp is treated as "waiting since forever" (0) rather
 * than skipped. A message whose time we cannot read is still a message somebody
 * sent, and the safe direction for a bad value is delivering too early, never
 * holding it back for a day.
 */
export function oldestMessageAt(queue: QueuedPrompt[]): number | null {
  let oldest: number | null = null
  for (const entry of queue) {
    if (entry.kind !== 'message') {
      continue
    }
    const at = Date.parse(entry.sentAt)
    const value = Number.isNaN(at) ? 0 : at
    if (oldest === null || value < oldest) {
      oldest = value
    }
  }
  return oldest
}

/**
 * How much longer the queue has to wait: 0 when it is due now, null when there
 * is nothing waiting on Presence at all.
 *
 * Returning the remainder rather than a boolean is what lets the caller arm a
 * timer for exactly the right moment instead of polling to find out.
 */
export function msUntilDue(queue: QueuedPrompt[], windowMs: number, now: number): number | null {
  const oldest = oldestMessageAt(queue)
  if (oldest === null) {
    return null
  }
  return Math.max(0, oldest + windowMs - now)
}
