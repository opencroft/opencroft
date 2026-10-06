// Shared session process-state derivation — isomorphic, no server-only imports —
// so both a client component (the chat list) and a server module (send-message
// node actions) classify a session identically instead of keeping their own
// copy in sync by hand.

export type SessionStatus = 'offline' | 'idle' | 'queued' | 'working' | 'waiting'

/**
 * The session keys in each activity, as the server reads them and as it pushes
 * them to a page: blocked on someone (pending), a turn running (active),
 * background work running (background), messages held for a later turn
 * (queued), a context compaction in progress (compacting — not a status of its
 * own, it always runs inside a turn), and a live agent process at all (alive —
 * a superset of the others).
 */
export interface SessionActivitySets {
  pending: ReadonlySet<string>
  active: ReadonlySet<string>
  background: ReadonlySet<string>
  queued: ReadonlySet<string>
  compacting: ReadonlySet<string>
  alive: ReadonlySet<string>
}

// Priority: waiting (a permission request or a question left for someone)
// beats working (active turn, or live background work the harness reported — a
// session whose own turn is over but whose subagents are still out IS working,
// and the idle reaper reading this status must not touch it) beats queued (no
// turn, but messages are held for one — the reading cadence has not come round,
// or delivery is paused) beats idle (alive, none of those) beats offline (no
// process). A turn blocked on someone is still in flight, so pending and active
// are both true while it waits — which is why waiting has to come first — and a
// running turn's queue is simply its next turn, which is why working beats
// queued. All are subsets of alive. Always returns a real state — offline is a
// real, always-shown state, not "no status".
function classify(flags: {
  awaitingUser: boolean
  turnActive: boolean
  backgroundWork: boolean
  messagesQueued: boolean
  alive: boolean
}): SessionStatus {
  if (flags.awaitingUser) {
    return 'waiting'
  }
  if (flags.turnActive || flags.backgroundWork) {
    return 'working'
  }
  if (flags.messagesQueued) {
    return 'queued'
  }
  if (flags.alive) {
    return 'idle'
  }
  return 'offline'
}

// For a surface reading the activity sets — a list of sessions it does not
// have open, so every input arrives the same way.
export function deriveSessionStatus(sessionKey: string, sets: SessionActivitySets): SessionStatus {
  return classify({
    awaitingUser: sets.pending.has(sessionKey),
    turnActive: sets.active.has(sessionKey),
    backgroundWork: sets.background.has(sessionKey),
    messagesQueued: sets.queued.has(sessionKey),
    alive: sets.alive.has(sessionKey),
  })
}
