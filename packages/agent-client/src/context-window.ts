import { findAdapter } from './resolve'
import type { AgentSelection } from './types'

// Which context window a session may show a ratio against, given whatever its
// harness reported alongside the reading.
//
// The test is provenance, not arithmetic. A window is displayed only when it
// comes from an authority we can stand behind — never because a reported
// figure happens to look plausible, and never merely because this particular
// reading has not yet contradicted it.
//
// A harness `size` is not such an authority on its own. An external ACP bridge
// seeds a family default and reports it as fact until a completed turn hands
// back the model's real window; nothing in the protocol distinguishes that
// seeded guess from the corrected value that replaces it. So a bridged `size`
// is a claim, not evidence, and relaying it is how a session ends up rendered
// against a window nobody established.
//
// The two authorities, in order:
//
//  1. `selection.contextWindow` — a window somebody configured for this model.
//     Deliberate by construction, and the agent node's own field already
//     states what leaving it empty means: "the chat then shows usage without a
//     percentage."
//  2. For an in-process (native) session, the reported size itself — because we
//     computed it. `resolveContextWindow` in native-harness.ts returns the
//     configured value, or the one discovered from the endpoint's `/models`,
//     and 0 when it has neither. It cannot return a guess, so a native `size`
//     is the discovery authority arriving over the only channel it has. This
//     holds only while that function refuses to invent a number; if it ever
//     gains a fallback that guesses, this stops being sound.
//
// Anything else yields `undefined`: tokens used, no ratio. That is an existing
// rendering — the same one a model with no configured window already gets —
// rather than a new state to design for.
//
// This deliberately withholds windows that may well be correct. A bridge that
// has already corrected itself reports a true figure we still cannot tell from
// its guess, and that figure is dropped with the rest. Showing a number we
// cannot vouch for is the failure this exists to prevent; the remedy is to
// configure the window, not to trust the wire harder.
export function knownContextWindow(selection: AgentSelection, reportedSize?: number): number | undefined {
  const configured = usableContextWindow(selection.contextWindow)
  if (configured !== undefined) {
    return configured
  }
  if (findAdapter(selection.adapterId)?.kind === 'native') {
    return usableContextWindow(reportedSize)
  }
  return undefined
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
