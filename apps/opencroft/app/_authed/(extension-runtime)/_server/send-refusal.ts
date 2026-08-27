/**
 * Say, where a person will read it, that a message was refused.
 *
 * The guard that refuses an unattributable send was correct and invisible: its
 * refusal reached stdout and nothing else, and stdout is not a place anybody
 * looks. To the one party who could tell the difference — whoever was waiting
 * in the thread the message was aimed at — a refused delivery and nobody
 * having written anything are the same silence. The wiring it refused was
 * precisely the kind nobody would notice going quiet.
 *
 * SO THE REPORT GOES TO THE REFUSED MESSAGE'S OWN DESTINATION. There is no
 * configured operations thread in this system to send it to instead, and
 * inventing one would put a live address in source; the destination the
 * message already named needs no plumbing and reaches exactly the readers for
 * whom the silence was ambiguous.
 *
 * THE REFUSED TEXT IS NEVER REPEATED. Quoting it would hand a sender nobody
 * could name a way into a thread — the forgery the guard exists to prevent —
 * so a report that included it would have delivered the message it refused.
 * What a reader gets is the fact, the reason, and which wiring to go and fix.
 */

/**
 * How long repeats of one refusal are collected before their count is
 * reported.
 *
 * The window exists so a broken wiring firing every few seconds reads as one
 * report and a number rather than as hundreds of identical messages. It ends
 * by reporting, never by forgetting: nothing that happened inside it is
 * dropped, which is the difference between collapsing repeats and suppressing
 * them.
 */
const DIGEST_WINDOW_MS = 5 * 60_000

/** One refused send, described by everything a reader needs and nothing more. */
export interface Refusal {
  /** The send-message node that refused — which wiring to go and fix. */
  nodeId: string
  /** Why it refused, in the words the guard used. */
  reason: string
  /** The thread the refused message named, and so where its absence is felt. */
  threadRef: string
}

/**
 * Hands one report to the thread it names.
 *
 * Passed in rather than imported so this module owns WHAT is said and WHEN,
 * and knows nothing about how a message travels.
 *
 * MUST NOT THROW. The digest below is delivered from a timer, where there is
 * no caller left to catch anything — so a delivery that fails reports its own
 * failure and returns.
 */
export type ReportDelivery = (threadRef: string, message: string) => Promise<void>

interface OpenWindow {
  /**
   * Refusals since the report that opened this window. Only ever read when
   * the window closes, and the window always closes by reporting it.
   */
  count: number
  /**
   * Refreshed on every repeat, so the digest travels through the most recent
   * caller's wiring rather than through a closure captured five minutes ago.
   */
  deliver: ReportDelivery
}

// globalThis-backed for the reason the thread-delivery registry in ./stream.ts
// gives at length: Vite's dev SSR hands a module a fresh instance whenever
// something it imports changes, and module-scoped state silently starts over.
// Here that would cost a repeated full report rather than a broken send, but
// the mechanism is the same one and so is the fix.
const globalForRefusals = globalThis as unknown as {
  __SEND_REFUSAL_WINDOWS__?: Map<string, OpenWindow>
}
if (!globalForRefusals.__SEND_REFUSAL_WINDOWS__) {
  globalForRefusals.__SEND_REFUSAL_WINDOWS__ = new Map()
}
const openWindows = globalForRefusals.__SEND_REFUSAL_WINDOWS__

// One window per wiring per reason. Two different reasons on one node are two
// different things to fix, and collapsing them together would report one and
// hide the other behind its count. A space separates them because a node id
// never contains one, so no pair of keys can spell the same string.
function windowKey(refusal: Refusal): string {
  return `${refusal.nodeId} ${refusal.reason}`
}

function firstReport(refusal: Refusal): string {
  return [
    'A message aimed at this thread was refused, and nothing was delivered.',
    '',
    refusal.reason,
    '',
    `It came through send-message node ${refusal.nodeId}. Its text is deliberately not repeated here: a message whose sender could not be named must not reach a reader as content.`,
  ].join('\n')
}

function digestReport(refusal: Refusal, count: number): string {
  const plural = count === 1 ? 'message was' : 'messages were'
  return [
    `${count} further ${plural} aimed at this thread refused for the same reason, and nothing was delivered.`,
    '',
    refusal.reason,
    '',
    `All of them came through send-message node ${refusal.nodeId}.`,
  ].join('\n')
}

function closeWindowLater(key: string, refusal: Refusal): void {
  const timer = setTimeout(() => {
    const pending = openWindows.get(key)
    openWindows.delete(key)
    if (!pending || pending.count === 0) {
      return
    }
    void pending.deliver(refusal.threadRef, digestReport(refusal, pending.count))
  }, DIGEST_WINDOW_MS)
  // A pending report is not a reason to hold the process open. Widened rather
  // than assumed, because the same call returns a plain number elsewhere.
  ;(timer as { unref?: () => void }).unref?.()
}

/**
 * Report a refusal, in full the first time and as a count thereafter.
 *
 * The window is opened BEFORE the first report is awaited, so a second
 * refusal arriving while the first is still being delivered is counted rather
 * than reported as a second first.
 */
export async function reportRefusal(refusal: Refusal, deliver: ReportDelivery): Promise<void> {
  const key = windowKey(refusal)
  const open = openWindows.get(key)
  if (open) {
    open.count += 1
    open.deliver = deliver
    return
  }
  openWindows.set(key, { count: 0, deliver })
  closeWindowLater(key, refusal)
  await deliver(refusal.threadRef, firstReport(refusal))
}
