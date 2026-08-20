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
  const configured = selection.contextWindow
  if (configured !== undefined && configured > 0) {
    return configured
  }
  if (findAdapter(selection.adapterId)?.kind === 'native' && reportedSize !== undefined && reportedSize > 0) {
    return reportedSize
  }
  return undefined
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
// The second step is a sanity gate, not a second source: a window the reading
// itself disproves is false whoever supplied it. Provenance alone cannot catch
// this — a configured window is an authority, but an operator can still type a
// number smaller than what the session demonstrably holds, and rendering that
// as 265% would be the same impossible ratio this work started from, merely
// sourced from us instead of the bridge. The gate only ever REMOVES a ratio;
// it can never promote an unverified figure into one.
export function normalizeUsage(
  selection: AgentSelection,
  usage: { used: number; size?: number },
): { used: number; size?: number } {
  const known = knownContextWindow(selection, usage.size)
  const disproved = known !== undefined && usage.used > known
  return { used: usage.used, size: disproved ? undefined : known }
}
