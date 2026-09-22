// Shared session process-state derivation — isomorphic, no server-only imports —
// so both a client component (the chat list) and a server module (send-message
// node actions) classify a session identically instead of keeping their own
// copy in sync by hand.

export type SessionStatus = 'offline' | 'idle' | 'working' | 'waiting'

// Priority: waiting (a permission request or a question left for someone)
// beats working (active turn, or live background work the harness reported — a
// session whose own turn is over but whose subagents are still out IS working,
// and the idle reaper reading this status must not touch it) beats idle
// (alive, none of those) beats offline (no process). A turn blocked on someone
// is still in flight, so pending and active are both true while it waits —
// which is why waiting has to come first — and all are subsets of alive.
// Always returns a real state — offline is a real, always-shown state, not
// "no status".
function classify(flags: {
  awaitingUser: boolean
  turnActive: boolean
  backgroundWork: boolean
  alive: boolean
}): SessionStatus {
  if (flags.awaitingUser) {
    return 'waiting'
  }
  if (flags.turnActive || flags.backgroundWork) {
    return 'working'
  }
  if (flags.alive) {
    return 'idle'
  }
  return 'offline'
}

// For a surface reading the polled activity sets — a list of sessions it does
// not have open, so every input arrives the same way and up to one poll
// interval late.
export function deriveSessionStatus(
  sessionKey: string,
  keys: { pending: Set<string>; active: Set<string>; background: Set<string>; alive: Set<string> },
): SessionStatus {
  return classify({
    awaitingUser: keys.pending.has(sessionKey),
    turnActive: keys.active.has(sessionKey),
    backgroundWork: keys.background.has(sessionKey),
    alive: keys.alive.has(sessionKey),
  })
}
