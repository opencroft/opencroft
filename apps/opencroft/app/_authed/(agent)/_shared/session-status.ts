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
//
// The ordering lives here alone, and both derivations below route through it:
// a third state added to one of them and missed by the other is exactly the
// drift this module exists to prevent.
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

// For a surface that has ONE session open and is reading its event stream.
// Same four states and the same ordering; the difference is only where each
// input can honestly come from, and it is not one source:
//
//   - `live` comes from the stream, which reports a turn beginning and ending
//     and a permission request being raised as they happen. A surface with the
//     session open therefore learns "busy" immediately, rather than up to a
//     poll interval later.
//   - `alive` cannot. The event stream carries conversation events only, with
//     no session-lifecycle event among them: nothing is emitted when a session
//     process goes away underneath an open screen. So "a process exists at
//     all" has to come from the polled set, and passing it is what stops a
//     session reaped for idleness from still reading as idle.
//
// Callers that only distinguish busy from not-busy may pass `alive: true` and
// ignore the offline state — but they have to choose that explicitly, rather
// than get it by an assumption baked in here.
export function deriveOpenSessionStatus(
  live: { turnActive: boolean; permissionPending: boolean },
  alive: boolean,
): SessionStatus {
  return classify({ permissionPending: live.permissionPending, turnActive: live.turnActive, alive })
}
