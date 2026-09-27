import type { UsageTokens } from 'agent-chat/components/usage-cost'
import { displayableContextWindow } from 'agent-client/context-window'
import type { RateLimitWindow, SessionCost } from 'agent-client/types'

// How much context a session is holding, and whether a compaction reduced it.
//
// Its own module because both ends of the compaction path need it: stream.ts
// reads usage around the compaction and decides from it, host.ts reports it on
// every session. host.ts already imports stream.ts, so these cannot live in
// either without a cycle.

export interface ContextUsage {
  usedTokens: number
  /** null when the harness reports usage but cannot name the model's window. */
  contextLimit: number | null
  /**
   * The session's cumulative cost, when the harness prices the session. Lives
   * beside the context reading because that is where the harness reports it
   * (usage_update.cost), not because the two are the same measurement.
   */
  cost?: SessionCost
  /**
   * The account's reported rate-limit windows, last known per window —
   * subscription state the harness reports alongside usage readings. Absent
   * until the first report, never cleared by a reading that lacks them.
   */
  rateLimits?: RateLimitWindow[]
  /**
   * The session's authoritative token account as of now — a grouped SUM of
   * its recorded turns' per-model counters, subagents included (see
   * chat-usage-store's queryChatUsageTokensBySession), independent of the
   * used/size context window above. Absent when the session has never
   * recorded a turn. This is the BASE the client seeds a session's running
   * token account from at open and adds its own live increments onto — see
   * use-acp-session's seedUsage/mergeTokenAccounts.
   */
  tokens?: UsageTokens
  /**
   * Wall-clock time (ms since epoch) this figure was reported, present ONLY
   * on a last-known reading served from the persisted store for an offline
   * session — never on a live one. Its absence means the figure is what the
   * session is holding right now; its presence means the session has since
   * gone offline and this is what it held as of that timestamp. A caller
   * that renders a stale figure dimmed reads this to decide.
   */
  asOf?: number
}

// Maps agent-client's usage snapshot to the wire shape, with a last-known
// fallback for an offline session. Absent usage becomes null, never zeros: a
// session that has never reported usage (never loaded, not finished a turn
// since it was loaded, or a harness that reports none at all) holds a
// genuinely UNKNOWN amount, and a caller that read that as zero would skip a
// compaction that was due.
//
// `lastKnown` is tried only when `usage` itself is absent (the session is not
// currently loaded) — a live reading always wins and never carries `asOf`.
// Passing neither still returns null: an offline session with nothing ever
// persisted is exactly as unknown as one that was never loaded.
//
// `knownWindow` is the offline branch's window, and it REPLACES the persisted
// `size` rather than filling in for a missing one. This is the third door a
// reading takes to a surface: the live path and the restore path both run the
// reading through agent-client's normaliseUsage, but a persisted pair read for
// an offline session reaches the wire without passing either. Relaying its
// `size` would relay whatever an older build wrote from a harness report —
// the exact figure the other two doors exist to refuse.
//
// The offline branch cannot ask which window a native session discovered (that
// lives in a harness process which, by definition here, is not running), so a
// configured window is the only authority available to it.
//
// SO THIS DOOR IS DELIBERATELY STRICTER THAN THE OTHER TWO, and the three must
// not be collapsed into one. The live and restore paths hold a selection, so
// they can accept a native session's discovered size as its own authority;
// this one has no selection and no way to tell a discovered size from a
// bridged claim, so it accepts neither and takes the configured window or
// nothing. The consequence is real and intended rather than overlooked: a
// native session whose window was discovered but never configured shows no
// ratio while it is offline, and has it back the moment it loads. Configuring
// the window on the agent closes that gap.
export function toContextUsage(
  usage?: {
    used: number
    size?: number
    cost?: SessionCost
    rateLimits?: RateLimitWindow[]
  },
  lastKnown?: { used: number; size?: number; cost?: SessionCost; rateLimits?: RateLimitWindow[]; at: number },
  knownWindow?: number,
): ContextUsage | null {
  if (usage) {
    return {
      usedTokens: usage.used,
      contextLimit: usage.size ?? null,
      ...(usage.cost ? { cost: usage.cost } : {}),
      ...(usage.rateLimits ? { rateLimits: usage.rateLimits } : {}),
    }
  }
  if (lastKnown) {
    // The same gate the live and restore doors apply, called rather than
    // restated: a window this reading disproves is false whoever supplied it.
    return {
      usedTokens: lastKnown.used,
      contextLimit: displayableContextWindow(knownWindow, lastKnown.used) ?? null,
      ...(lastKnown.cost ? { cost: lastKnown.cost } : {}),
      ...(lastKnown.rateLimits ? { rateLimits: lastKnown.rateLimits } : {}),
      asOf: lastKnown.at,
    }
  }
  return null
}

// Did compaction actually reduce what the session holds?
//
//   shrank    -> true   compaction worked
//   grew      -> false  it did not: a harness with no `/compact` answers the
//                       command as an ordinary message, so the context is
//                       LARGER afterwards. This is the failure signal.
//   unchanged -> null   no new reading landed, so nothing can be concluded.
//   unknown   -> null   usage missing on either side.
//
// Unchanged is null rather than false on purpose. A usage figure identical to
// the one before is indistinguishable from a stale one: the harness reports
// usage as a session update, and nothing in ACP orders that update against the
// prompt response, so "no report has arrived yet" and "the report says the same
// number" look the same from here. Calling that false would claim a failure
// that was never observed. A genuine failure to compact does not land here —
// answering the command as a message adds tokens, which is the `grew` branch.
//
// The distinction has teeth: the caller re-sends the session's instructions on
// true and null, and skips on false, so a wrong false silently drops the
// instruction restore.
export function compactionVerdict(before: ContextUsage | null, after: ContextUsage | null): boolean | null {
  if (!before || !after) {
    return null
  }
  if (after.usedTokens === before.usedTokens) {
    return null
  }
  return after.usedTokens < before.usedTokens
}
