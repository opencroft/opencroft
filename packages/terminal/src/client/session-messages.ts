import type { ClientMessage, TerminalConfig } from '../types'

/**
 * Where a `Terminal` gets its session from.
 *
 * `connect` opens one from a connection config, or re-attaches to the one its key names. `attach`
 * only ever watches an existing session by key — output that server code started — and has no
 * config to open anything with. The difference matters at every point the client would otherwise
 * fall back to opening a session, because a key naming a job that has gone must not become a fresh
 * shell under that key.
 */
export type TerminalSource =
  | { kind: 'connect'; connection: TerminalConfig; command?: string; sessionKey?: string }
  | { kind: 'attach'; sessionKey: string }

/** What this mount already knows about its session, from an earlier `connected` on it. */
export interface ReattachState {
  /** Set once the session has answered `connected` during this mount. */
  attemptingReattach: boolean
  sessionId: string | null
}

export function connectMessage(
  connection: TerminalConfig,
  command: string | undefined,
  cols: number,
  rows: number,
  sessionKey: string | undefined,
): ClientMessage {
  const extra: Record<string, unknown> = {}
  if (command) {
    extra.command = command
  }
  if (sessionKey) {
    extra.sessionKey = sessionKey
  }
  if (connection.type === 'ssh') {
    return { type: 'connect', payload: { ...connection.config, ...extra, cols, rows } }
  }
  if (connection.type === 'wsl') {
    return { type: 'wsl', payload: { ...connection.config, ...extra, cols, rows } }
  }
  return { type: 'local', payload: { ...connection.config, ...extra, cols, rows } }
}

/** The first message on a newly opened socket — on mount, and on every reconnect after a drop. */
export function openingMessage(
  source: TerminalSource,
  state: ReattachState,
  cols: number,
  rows: number,
): ClientMessage {
  if (source.kind === 'connect' && !(state.attemptingReattach && (state.sessionId || source.sessionKey))) {
    return connectMessage(source.connection, source.command, cols, rows, source.sessionKey)
  }
  return {
    type: 'attach',
    payload: { sessionId: state.sessionId ?? undefined, sessionKey: source.sessionKey, cols, rows },
  }
}

/**
 * What to send when the server says the session it was asked for does not exist: a fresh session
 * for a `connect` source, and nothing at all for an `attach` one, whose session is gone for good.
 */
export function sessionGoneMessage(source: TerminalSource, cols: number, rows: number): ClientMessage | null {
  if (source.kind === 'attach') {
    return null
  }
  return connectMessage(source.connection, source.command, cols, rows, source.sessionKey)
}
