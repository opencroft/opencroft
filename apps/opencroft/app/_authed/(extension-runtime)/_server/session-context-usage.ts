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
export function toContextUsage(
  usage?: { used: number; size?: number },
  lastKnown?: { used: number; size?: number; at: number },
): ContextUsage | null {
  if (usage) {
    return { usedTokens: usage.used, contextLimit: usage.size ?? null }
  }
  if (lastKnown) {
    return { usedTokens: lastKnown.used, contextLimit: lastKnown.size ?? null, asOf: lastKnown.at }
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
