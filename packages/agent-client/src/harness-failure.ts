// When a harness subprocess dies before (or during) the ACP handshake, the
// protocol error that surfaces describes the transport — "ACP connection
// closed" — not why the process is gone. The process itself almost always
// said why on stderr first: a container that isn't running, a binary that
// couldn't be fetched, a rejected token. That text is the actionable part, so
// it becomes the error the caller sees.

export interface HarnessFailure {
  /** Tail of the process's stderr, most recent last. */
  stderr: string[]
  /** The spawn-level error, when the process never started at all. */
  spawnError?: Error
  /** Exit code / signal, when the process started and then exited. */
  exit?: { code: number | null; signal: NodeJS.Signals | null }
}

// Longest stderr excerpt to carry into the message. Enough for a daemon error
// plus a line of context, short enough to stay readable where errors surface
// (a node's error strip, a tool result).
const MAX_DETAIL = 500

function tidy(stderr: string[]): string {
  const lines = stderr
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    return ''
  }
  // Last lines first: a failing process prints its diagnosis last, after any
  // progress chatter.
  const detail = lines.slice(-3).join('; ')
  return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail
}

function describeExit(exit: HarnessFailure['exit']): string {
  if (!exit) {
    return ''
  }
  if (exit.signal) {
    return `killed by ${exit.signal}`
  }
  return exit.code === null ? '' : `exit code ${exit.code}`
}

// Compose the error a caller should see for a harness that failed to start.
// `cause` is the original transport error, returned unchanged when the process
// left nothing better to say — never swallowed, since a message invented from
// no evidence would be worse than the protocol one.
//
// Only substitutes when the process actually died (an exit or a spawn-level
// error) — `initialize` can also reject against a harness that is alive and
// merely failed the handshake at the protocol level, and stderr from a live
// process is routine progress chatter, not a diagnosis. Reporting that as
// "Agent failed to start" would bury the real, protocol-level error in `cause`.
export function harnessStartError(failure: HarnessFailure, cause: unknown): Error {
  const detail = failure.exit || failure.spawnError ? tidy(failure.stderr) || failure.spawnError?.message || '' : ''
  if (!detail) {
    return cause instanceof Error ? cause : new Error(String(cause))
  }
  const exit = describeExit(failure.exit)
  const suffix = exit ? ` (${exit})` : ''
  const error = new Error(`Agent failed to start${suffix}: ${detail}`)
  if (cause !== undefined) {
    error.cause = cause
  }
  return error
}
