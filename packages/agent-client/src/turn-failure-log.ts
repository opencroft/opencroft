// Readers for a harness's own record of why a turn failed, kept outside ACP
// (HarnessAdapter.failureLog names the format). Server-only: they read files
// under the harness's home.

import { COPILOT_FAILURE_LOG } from './copilot-event-log'
import type { FailureLogFormat } from './harness-adapters'
import type { SessionFailure } from './types'

/**
 * A reply chunk starting with `replyPrefix` is held back until the turn
 * settles. If the log then holds a failure whose `reply` is exactly that text,
 * the turn ends with the failure and the chunk is dropped; otherwise the chunk
 * is delivered as it came.
 */
export interface TurnFailureLog {
  replyPrefix: string
  /** The position a turn's read starts from, taken as the turn starts. */
  mark: (home: string, sessionId: string) => number
  /** The failure logged since `from`, and the reply text the harness sent for it. */
  read: (home: string, sessionId: string, from: number) => { reply: string; failure: SessionFailure } | undefined
}

export const TURN_FAILURE_LOGS: Record<FailureLogFormat, TurnFailureLog> = {
  'copilot-session-events': COPILOT_FAILURE_LOG,
}
