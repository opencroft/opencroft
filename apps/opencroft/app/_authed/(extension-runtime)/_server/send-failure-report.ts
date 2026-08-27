/**
 * Say, where a person will read it, that a message did not arrive.
 *
 * The failure mode of a message system is silence, and silence is also its
 * normal state. Everything else in this application announces a fault by
 * something not looking right; a dropped send announces itself by everything
 * looking normal, and the first person to wonder why does so hours later. So a
 * failure here reached stdout and nothing else, and stdout is not a surface
 * anybody reads.
 *
 * EVERY FAILURE, not only the refusal this started as. Nothing on the send
 * path retries — one attempt per wiring, and a caught error means that message
 * is gone — so there is no recovered case to tell apart from a permanent one.
 * If a retry is ever added, THAT is when this needs to distinguish them, and
 * adding the distinction now would be a branch for a caller that does not
 * exist.
 *
 * THE REPORT GOES TO THE MESSAGE'S OWN DESTINATION. There is no configured
 * operations thread in this system to send it to instead, and inventing one
 * would put a live address in source; the destination the message already
 * named needs no plumbing and reaches exactly the readers for whom the silence
 * was ambiguous.
 *
 * THE UNDELIVERED TEXT IS NEVER REPEATED. For a refusal that is a security
 * property: quoting it would hand a sender nobody could name a way into a
 * thread, which is the forgery the guard exists to prevent. For every other
 * failure it is a narrower point but the same one — a report carrying the
 * message reads as the message arriving, and a delivery is not this function's
 * job to attempt. What a reader gets is the fact, the reason, and which wiring
 * to go and fix.
 */

/**
 * How long repeats of one failure are collected before their count is
 * reported.
 *
 * The window exists so a broken wiring firing every few seconds reads as one
 * report and a number rather than as hundreds of identical messages. It ends
 * by reporting, never by forgetting: nothing that happened inside it is
 * dropped, which is the difference between collapsing repeats and suppressing
 * them.
 */
const DIGEST_WINDOW_MS = 5 * 60_000

/** One send that did not arrive, described by what a reader needs and no more. */
export interface SendFailure {
  /** The send-message node it failed at — which wiring to go and fix. */
  nodeId: string
  /** What went wrong, in the words the thing that failed used. */
  reason: string
  /** The thread the message named, and so where its absence is felt. */
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
function windowKey(failure: SendFailure): string {
  return `${failure.nodeId} ${failure.reason}`
}

function firstReport(failure: SendFailure): string {
  return [
    'A message aimed at this thread was not delivered.',
    '',
    failure.reason,
    '',
    `It came through send-message node ${failure.nodeId}. Nothing retried it, so it is gone rather than late. Its text is deliberately not repeated here: a report that carried the message would read as the message arriving.`,
  ].join('\n')
}

function digestReport(failure: SendFailure, count: number): string {
  const plural = count === 1 ? 'message was' : 'messages were'
  return [
    `${count} further ${plural} aimed at this thread not delivered, for the same reason.`,
    '',
    failure.reason,
    '',
    `All of them came through send-message node ${failure.nodeId}, and none of them were retried.`,
  ].join('\n')
}

function closeWindowLater(key: string, failure: SendFailure): void {
  const timer = setTimeout(() => {
    const pending = openWindows.get(key)
    openWindows.delete(key)
    if (!pending || pending.count === 0) {
      return
    }
    void pending.deliver(failure.threadRef, digestReport(failure, pending.count))
  }, DIGEST_WINDOW_MS)
  // A pending report is not a reason to hold the process open. Widened rather
  // than assumed, because the same call returns a plain number elsewhere.
  ;(timer as { unref?: () => void }).unref?.()
}

/**
 * Report a failed send, in full the first time and as a count thereafter.
 *
 * The window is opened BEFORE the first report is awaited, so a second failure
 * arriving while the first is still being delivered is counted rather than
 * reported as a second first.
 */
export async function reportSendFailure(failure: SendFailure, deliver: ReportDelivery): Promise<void> {
  const key = windowKey(failure)
  const open = openWindows.get(key)
  if (open) {
    open.count += 1
    open.deliver = deliver
    return
  }
  openWindows.set(key, { count: 0, deliver })
  closeWindowLater(key, failure)
  await deliver(failure.threadRef, firstReport(failure))
}
