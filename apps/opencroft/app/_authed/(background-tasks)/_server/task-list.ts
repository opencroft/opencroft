// The instance's background tasks as the MCP audit page lists them, beside its
// live sessions and for the same question — can I restart now — asked of the
// work sessions leave behind: a runner task carries on through a restart, an
// in-process one does not, whatever its kind. `runner` is what says which.

import { type BackgroundTasks, backgroundTasks } from '@/app/_authed/(background-tasks)/_server/service'
import type {
  BackgroundTaskKind,
  BackgroundTaskRunner,
  BackgroundTaskState,
} from '@/app/_authed/(background-tasks)/_server/types'

export interface BackgroundTaskRow {
  id: string
  summary: string
  kind: BackgroundTaskKind
  runner: BackgroundTaskRunner
  /** Tool or action id. */
  name: string
  /** Empty when the call named nothing to run against. */
  target: string
  /** The calling session's key; null for a caller with no session. */
  session: string | null
  agent: string | null
  state: BackgroundTaskState
  reason: string | null
  // Epoch milliseconds, like a live session's lastActivityAt.
  startedAt: number
  finishedAt: number | null
}

export interface BackgroundTaskList {
  tasks: BackgroundTaskRow[]
  // Why the list could not be read, when it could not. The rest of the page
  // still works, and an empty list must not read as "nothing is running".
  error: string | null
}

/** Everything running, and what ended in the last day. Never throws. */
export async function backgroundTaskList(
  service: Pick<BackgroundTasks, 'listRecent'> = backgroundTasks,
): Promise<BackgroundTaskList> {
  try {
    const records = await service.listRecent()
    const tasks = records.map((record) => ({
      id: record.taskId,
      summary: record.summary,
      kind: record.kind,
      runner: record.runner,
      name: record.name,
      target: record.target,
      session: record.sessionKey ?? null,
      agent: record.agent,
      state: record.state,
      reason: record.reason ?? null,
      startedAt: record.startedAt.getTime(),
      finishedAt: record.finishedAt?.getTime() ?? null,
    }))
    return { tasks, error: null }
  } catch (error) {
    return { tasks: [], error: error instanceof Error ? error.message : String(error) }
  }
}
