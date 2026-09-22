/**
 * The contract between what starts background work and what runs it.
 *
 * A background task is work a tool or an action started for a caller and did
 * not wait for: a command left running on a node, or an action handler whose
 * promise nobody awaits. The service owns everything after the start — the
 * durable record, watching the work, timing it out, stopping it, and telling
 * the calling session how it ended. A tool only starts one and hands the id
 * back, which is what lets the call return long before the work does.
 *
 * Types only, so a tool can be written against this while the service is not.
 */

/**
 * Where a task is in its life. The terminal states are the vocabulary
 * `AsyncTaskInfo` already renders in the chat, so a task this host runs draws
 * exactly like one a harness reported. `stopped` covers both a cancel and a
 * timeout; `reason` says which.
 */
export type BackgroundTaskState = 'running' | 'completed' | 'failed' | 'stopped'

export type BackgroundTaskKind = 'tool' | 'app-action' | 'node-action'

/**
 * Who started a task — which is also where its result goes.
 *
 * `sessionId` is absent for a caller that has no session, such as an MCP
 * client over HTTP. Its task still runs and can be asked about by id; there is
 * simply no conversation to tell when it ends.
 */
export interface BackgroundTaskOwner {
  agent: string | null
  sessionId?: string
}

export interface BackgroundTaskRecord {
  /** A UUID, and also the `asyncTaskId` of the task's entry in the chat. */
  taskId: string
  agent: string | null
  /**
   * The calling session's key — resolved from its id at start, because the
   * key is the name that survives a restart and the id is not. Absent when
   * the caller had no session: nobody is notified.
   */
  sessionKey?: string
  kind: BackgroundTaskKind
  /** Tool or action id: `remote_exec`, `deploy`. */
  name: string
  /** What it runs against, for display: a terminal target, a node id, an app address. */
  target: string
  /** One line saying what the task is, in terms the caller would recognise. */
  summary: string
  state: BackgroundTaskState
  /** Why it ended the way it did, whenever the state alone does not say. */
  reason?: string
  startedAt: Date
  finishedAt?: Date
  /** Null: no limit. */
  timeoutMs: number | null
  exitCode?: number
  /** The end of the output, bounded — never the whole of it. */
  outputTail?: string
  /** Where the full output lives on the node. Node tasks only. */
  logPath?: string
  /** When the result reached the calling session. Unset: still owed. */
  deliveredAt?: Date
}

export interface StartNodeTaskInput {
  owner: BackgroundTaskOwner
  name: 'remote_exec' | 'remote_script'
  /** The terminal-context target, exactly as the remote tools accept it. */
  target: string
  /** remote_exec: the shell command. remote_script: the script body. */
  command: string
  cwd?: string
  /**
   * Secret NAMES. Their values reach the process through its environment and
   * are never written anywhere on the node.
   */
  secrets?: string[]
  timeoutMs: number | null
  summary: string
}

export interface StartInProcessTaskInput {
  owner: BackgroundTaskOwner
  kind: 'app-action' | 'node-action'
  name: string
  target: string
  summary: string
  timeoutMs: number | null
  /**
   * The work itself. The signal aborts on cancel or timeout; a handler that
   * ignores it keeps running, which is why a cancel of one reports
   * `requested` rather than `stopped`.
   */
  run: (signal: AbortSignal) => Promise<unknown>
}

export type CancelOutcome =
  /** The work was stopped. */
  | 'stopped'
  /** Stop was asked of work that may not honour it — an in-process handler. */
  | 'requested'
  /** It had already ended. */
  | 'not-running'
  | 'unknown-task'

export interface BackgroundTaskService {
  startNodeTask(input: StartNodeTaskInput): Promise<BackgroundTaskRecord>
  startInProcessTask(input: StartInProcessTaskInput): Promise<BackgroundTaskRecord>
  get(taskId: string): Promise<BackgroundTaskRecord | null>
  /**
   * The tasks this owner started, newest first: the session's when it has
   * one, otherwise the agent's own sessionless ones.
   */
  listForOwner(owner: BackgroundTaskOwner): Promise<BackgroundTaskRecord[]>
  /** Every task still running, across the instance. */
  listRunning(): Promise<BackgroundTaskRecord[]>
  cancel(taskId: string): Promise<CancelOutcome>
  /**
   * Keys of sessions with a task still running. Synchronous because it is
   * read on hot paths — the session status every chat list derives, and the
   * idle reaper — so the service keeps it in memory rather than asking the
   * database each time.
   */
  runningSessionKeys(): ReadonlySet<string>
}
