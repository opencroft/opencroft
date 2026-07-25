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
export function deriveSessionStatus(
  sessionKey: string,
  keys: { pending: Set<string>; active: Set<string>; alive: Set<string> },
): SessionStatus {
  if (keys.pending.has(sessionKey)) {
    return 'waiting'
  }
  if (keys.active.has(sessionKey)) {
    return 'working'
  }
  if (keys.alive.has(sessionKey)) {
    return 'idle'
  }
  return 'offline'
}
