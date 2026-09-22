// The one place the service touches the agent engine's host-task API.
//
// Three pieces of it are the engine's to provide: `upsertAsyncTask` puts a task
// this host runs into a session's own record of its tasks (which is what the
// status, the strip and the transcript all read), `notify` tells the session
// how the task ended, outside its queue, and `stopHostTask` is how the engine
// hands a stop pressed in the chat back to the host that runs the task.
//
// Everything that uses them goes through this file, typed against the shapes
// below, so the service depends on the engine through one seam only.

import type { AgentClientOptions, createAgentClient } from 'agent-client/agent-client'
import type { AsyncTaskInfo } from 'agent-client/types'

/** A task as the host states it. The engine marks every such record `origin: 'host'`. */
export type HostAsyncTaskInfo = AsyncTaskInfo

export interface StopHostTaskRequest {
  sessionId: string
  sessionKey?: string
  asyncTaskId: string
}

export interface HostTaskEngine {
  listSessions(): { id: string; sessionKey?: string }[]
  /**
   * Replace the session's record of this task — the WHOLE record: a field left
   * out is cleared, not kept. False when the session is not in memory.
   */
  upsertAsyncTask(sessionId: string, task: HostAsyncTaskInfo): boolean
  /**
   * Hand `text` to the session's harness outside its queue. True once handed
   * over; false when the session went away first. It can also be false after
   * the text went out, so a retry can repeat a notification — delivery is at
   * least once. Held, not failed, while delivery is asleep: the promise stays
   * pending until the instance wakes.
   */
  notify(sessionId: string, text: string): Promise<boolean>
}

type AgentClient = ReturnType<typeof createAgentClient>

// Both return what they are given, as typed: the compiler checks that the
// engine still offers what this service relies on.
export function hostTaskEngine(client: AgentClient): HostTaskEngine {
  return client
}

export function stopHostTaskOption(stop: (request: StopHostTaskRequest) => Promise<boolean>): AgentClientOptions {
  return { stopHostTask: stop }
}
