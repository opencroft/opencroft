// Shared session process-state derivation — isomorphic, no server-only imports —
// so both a client component (the chat list) and a server module (send-message
// node actions) classify a session identically instead of keeping their own
// copy in sync by hand.

export type SessionStatus = 'offline' | 'idle' | 'working' | 'waiting'

// Priority: waiting (pending permission) beats working (active turn) beats
// idle (alive, neither) beats offline (no process) — pending and active are
// never both true in practice (a turn blocked on a permission request has
// already paused), but both are subsets of alive, so the order matters for
// those two. Always returns a real state — offline is a real, always-shown
// state, not "no status".
function classify(flags: { permissionPending: boolean; turnActive: boolean; alive: boolean }): SessionStatus {
  if (flags.permissionPending) {
    return 'waiting'
  }
  if (flags.turnActive) {
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
  keys: { pending: Set<string>; active: Set<string>; alive: Set<string> },
): SessionStatus {
  return classify({
    permissionPending: keys.pending.has(sessionKey),
    turnActive: keys.active.has(sessionKey),
    alive: keys.alive.has(sessionKey),
  })
}
