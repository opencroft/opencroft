import type { AgentSelection } from './types'

// Which context window a session may show a ratio against, given whatever its
// harness reported alongside the reading. Two sources, in order:
//
//  1. `selection.contextWindow` — a window somebody configured for this model.
//     Deliberate by construction, and it wins over anything reported.
//  2. The size the harness reported with the reading itself.
//
// The reported size used to be withheld for external ACP bridges: the old
// claude bridge seeded a family default and reported it as fact, with nothing
// on the wire distinguishing the guess from a later corrected value, so every
// bridged session without a configured window permanently read "window size
// not reported". The rule now is that hiding the window
// forever costs more than the residual risk of briefly relaying a wrong one —
// and the risk has narrowed since the rule was written: the bridge now learns
// each model's real window from the harness's own per-model usage and caches
// it across sessions on the same provider, so a reported figure is the seeded
// guess only until the first completed turn corrects it.
//
// What deliberately does NOT come back is a client-side table of per-model
// windows: maintaining one is the failure mode this module replaced. And the
// claim/evidence distinction did not vanish, it moved: a figure this very
// reading contradicts is still dropped (displayableContextWindow), a
// non-positive or non-finite figure never passes (usableContextWindow), and
// the bridge already tracks internally which of its figures are authoritative
// — exposing that flag on the wire is proposed upstream, at which point this
// can tighten to authoritative-only without any client table.
export function knownContextWindow(selection: AgentSelection, reportedSize?: number): number | undefined {
  return usableContextWindow(selection.contextWindow) ?? usableContextWindow(reportedSize)
}

/**
 * A window a ratio may be drawn against, or undefined.
 *
 * THE ONE PLACE that decides what counts. The question is asked of three
 * different shapes -- this module's own typed selection field, and an agent
 * node's `data` reached by node id or by slug -- and each site used to carry
 * its own copy of the test. A rule about which numbers may be trusted is a
 * poor one to keep three copies of, which is the thesis of the work that
 * introduced this module.
 *
 * `unknown` in, because two of the callers read the value off untyped node
 * data, where a stored graph may hold anything. Non-finite is rejected as well
 * as non-positive: `Infinity` cannot arrive over JSON but can be produced
 * in-process, and it renders every session as 0% full forever.
 */
export function usableContextWindow(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * The window a reading may actually be shown against: the one we believe in,
 * unless this very reading disproves it.
 *
 * A sanity gate, not a second source. Provenance alone cannot catch this -- a
 * configured window is an authority, but an operator can still type a number
 * smaller than what the session demonstrably holds, and rendering that as 265%
 * would be the same impossible ratio this work started from, merely sourced
 * from us instead of the bridge. It only ever REMOVES a window; it can never
 * promote an unverified figure into one.
 *
 * `used == known` passes. A session sitting exactly at its window is an honest
 * 100%, not a contradiction.
 *
 * Takes a resolved window rather than a selection, so that EVERY door shares
 * it -- including the offline one, which has no selection to resolve from and
 * is handed a number. That door carried its own copy of this test, written in
 * the opposite polarity: it named the case that keeps the window where this
 * names the case that drops it, so an edit to one would not have visually
 * resembled the other.
 */
export function displayableContextWindow(known: number | undefined, used: number): number | undefined {
  const window = usableContextWindow(known)
  return window !== undefined && used <= window ? window : undefined
}

// One reading, normalised for display.
//
// Applied wherever a reading enters session state — a live `usage_update` and a
// restored figure alike — so the two cannot drift apart. That they had drifted
// is what let a restored session keep rendering a window the live path would
// already have refused.
//
// `used` is never touched. The token count is the harness's own measurement of
// something it can actually see; this rule has nothing to say about it, and a
// reading whose window is withheld still reports its tokens in full.
//
// Two steps, and the second is deliberately not a second source: which window
// is an authority (knownContextWindow), then whether this reading leaves it
// standing (displayableContextWindow). Both are shared with the offline door,
// which reaches the second directly because it has no selection for the first.
export function normalizeUsage(
  selection: AgentSelection,
  usage: { used: number; size?: number },
): { used: number; size?: number } {
  return { used: usage.used, size: displayableContextWindow(knownContextWindow(selection, usage.size), usage.used) }
}
