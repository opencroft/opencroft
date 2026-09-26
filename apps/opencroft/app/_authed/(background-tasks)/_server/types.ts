/**
 * The contract between what starts background work and what runs it.
 *
 * A background task is work a tool or an action started for a caller and did
 * not wait for: by default the handler's own promise, which nobody awaits;
 * for a tool that opts in, a command left running on a node. The service owns everything after the start — the
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

/** WHAT ran: a tool call, or an action of an app or a node. */
export type BackgroundTaskKind = 'tool' | 'app-action' | 'node-action'

/**
 * HOW a task runs, apart from what ran.
 *
 * - `in-process` — the default for every tool and every action: the handler's
 *   own promise, run by this server and not awaited. It asks nothing of any
 *   node, and it ends with this process — a restart fails it.
 * - `background-task-runner` — EXPERIMENTAL. A command detached on the node
 *   itself (background-task-runner.ts), which outlives this server and keeps a
 *   log there. A tool opts into it; nothing runs this way by default.
 */
export type BackgroundTaskRunner = 'in-process' | 'background-task-runner'

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
  runner: BackgroundTaskRunner
  /** Tool or action id: `remote_exec`, `deploy`. */
  name: string
  /**
   * What it runs against, for display: a terminal target, a node id, an app
   * address. Empty when the call named nothing to run against.
   */
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
  /** Where the full output lives on the node. Runner tasks only. */
  logPath?: string
  /** When the result reached the calling session. Unset: still owed. */
  deliveredAt?: Date
}

/** A command for the background task runner (EXPERIMENTAL) to run detached on a node. */
export interface StartRunnerTaskInput {
  owner: BackgroundTaskOwner
  /** The tool that started it, for display: `remote_exec`. */
  name: string
  /** The terminal-context target, exactly as the remote tools accept it. */
  target: string
  /**
   * `command`: `command` runs under the exec's own shell, as a synchronous
   * remote_exec would. `script`: `command` is a script body, written to the
   * node and run with bash, `args` as its positional parameters.
   */
  mode: 'command' | 'script'
  command: string
  /** `script` only: `$1`, `$2`, … inside it. */
  args?: string[]
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
  kind: BackgroundTaskKind
  name: string
  /** For display; empty when the call names nothing to run against. */
  target: string
  summary: string
  timeoutMs: number | null
  /**
   * The work itself. What it resolves to is the task's result: a string is
   * kept as written, anything else as JSON — bounded either way. A throw fails
   * the task with the error's message. The signal aborts on cancel or timeout;
   * a handler that ignores it keeps running, which is why a cancel of one
   * reports `requested` rather than `stopped`.
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
  /** EXPERIMENTAL — see BackgroundTaskRunner. */
  startRunnerTask(input: StartRunnerTaskInput): Promise<BackgroundTaskRecord>
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
  /** Called after every change to what runningSessionKeys() answers. Returns the unsubscribe. */
  subscribeRunningSessionKeys(listener: () => void): () => void
}
