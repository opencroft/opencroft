/**
 * The background-task family: starting a task on a caller's behalf, and the two
 * tools that ask how one is doing and stop one.
 *
 * A background task is a call the caller did not wait for — `remote_exec` or
 * `remote_script` with `background: true`, or an action whose declaration says
 * callers never wait for it. The service in (background-tasks) owns everything
 * after the start: the record, watching the work, the timeout, and telling the
 * calling conversation how it ended. What lives here is the tool side of that —
 * turning a call into a start, and a record into text.
 */

import type { ExecutionMode } from '@opencroft/core'

import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import type {
  BackgroundTaskOwner,
  BackgroundTaskRecord,
  BackgroundTaskService,
  CancelOutcome,
  StartNodeTaskInput,
} from '@/app/_authed/(background-tasks)/_server/types'
import {
  BACKGROUND_PARAM,
  DEFAULT_TIMEOUT_MINUTES,
  TIMEOUT_MINUTES_PARAM,
} from '@/app/_authed/(mcp)/_server/execution-mode'
import type { ToolCallerContext, ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail, textResult } from '@/app/_authed/(mcp)/_server/tool-shared'

// ── the service ──────────────────────────────────────────────────────

let substitute: BackgroundTaskService | undefined

/**
 * The service every background task is started through and asked about.
 *
 * Imported on first use, never at module scope. The service holds the database
 * and reaches nodes, which nothing that merely loads the tool registry should
 * pull in; and it runs node commands on the remote tools' own helpers while the
 * remote tools start tasks through here, so a static import would have the two
 * import each other.
 */
export async function backgroundTaskService(): Promise<BackgroundTaskService> {
  if (substitute) {
    return substitute
  }
  const { backgroundTasks } = await import('@/app/_authed/(background-tasks)/_server/service')
  return backgroundTasks
}

/**
 * Put a stand-in where the service is, or `undefined` to put the real one back.
 * For tests: the real one writes records and starts processes on nodes.
 */
export function substituteBackgroundTaskService(service: BackgroundTaskService | undefined): void {
  substitute = service
}

// ── starting a task ──────────────────────────────────────────────────

/**
 * Who a task is started for, which is also where its result goes. A caller with
 * no session keeps none here — the service reads that as "nobody to tell".
 */
export function taskOwner(caller: ToolCallerContext): BackgroundTaskOwner {
  return caller.sessionId ? { agent: caller.agent, sessionId: caller.sessionId } : { agent: caller.agent }
}

/**
 * `timeoutMinutes` as the service takes it: milliseconds, or null for no limit.
 *
 * `0` means no limit rather than "expire at once": an overnight run is a real
 * case, an instant expiry is not. Anything but a finite number of minutes, zero
 * or more, is refused rather than defaulted — a timeout typed wrong and quietly
 * replaced by an hour is a task killed at a time nobody chose.
 */
export function timeoutMsFrom(value: unknown): number | null {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MINUTES * 60_000
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(-32602, `${TIMEOUT_MINUTES_PARAM} must be a number of minutes, 0 or more (0 = no limit).`)
  }
  return value === 0 ? null : Math.round(value * 60_000)
}

/**
 * The one line a command task is known by: the caller's own description of it,
 * or failing that the command's first line.
 */
export function taskSummary(description: unknown, command: string): string {
  if (typeof description === 'string' && description.trim()) {
    return description.trim()
  }
  const firstLine = command.split('\n').find((line) => line.trim()) ?? ''
  return firstLine.trim()
}

/**
 * What a call that started a task answers with, in place of a result.
 *
 * It says whether a notification is coming, because that decides what the
 * caller does next. With a session the result is delivered into the
 * conversation, and polling for it only spends turns. Without one — an MCP
 * client over HTTP — nothing will ever arrive, and implying otherwise leaves the
 * caller waiting for good.
 */
export function taskStartedText(record: BackgroundTaskRecord, owner: BackgroundTaskOwner): string {
  const head = `Started background task ${record.taskId} — ${record.summary} (${timeoutText(record.timeoutMs)}).`
  if (owner.sessionId) {
    return (
      `${head}\nIts result will arrive in this conversation when it ends, so there is no need to poll. ` +
      'task_status shows how it is doing; task_cancel stops it.'
    )
  }
  return (
    `${head}\nNo notification will arrive: this caller has no session. ` +
    `Poll task_status with taskId "${record.taskId}" for its state and output; task_cancel stops it.`
  )
}

/**
 * Start a remote_exec or remote_script call as a node task. Called from inside
 * the handler, past the approval wrapper and past the same validation a call run
 * in place gets: a command run in the background is still a command somebody
 * approved.
 */
export async function startCommandTask(
  caller: ToolCallerContext,
  input: Omit<StartNodeTaskInput, 'owner'>,
): Promise<Record<string, unknown>> {
  const owner = taskOwner(caller)
  const record = await (await backgroundTaskService()).startNodeTask({ ...input, owner })
  return textResult(taskStartedText(record, owner))
}

/** What an action call came to: its result, or the answer for the task started in its place. */
export type ActionOutcome = { result: unknown } | { started: string }

/**
 * Run one action the way its declaration says a caller waits for it — the part
 * of `call` and `app_call` that is the same for both.
 *
 * `async` is always a task. `awaitable` is one when the caller passed
 * `background: true`, and either way `background` and `timeoutMinutes` belong to
 * the host — the listing offered them — so they are taken out before the
 * handler sees `params`. Anything else, `sync` or an action nobody declared,
 * runs as it always has with `params` untouched: a sync action that takes a
 * parameter called `background` owns it.
 */
export async function callAction(input: {
  execution: ExecutionMode | undefined
  params: Record<string, unknown>
  caller: ToolCallerContext
  task: { kind: 'node-action' | 'app-action'; name: string; target: string; summary: string }
  run: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
}): Promise<ActionOutcome> {
  const { execution, caller, task, run } = input
  let params = input.params
  let timeoutMs: number | null = DEFAULT_TIMEOUT_MINUTES * 60_000
  if (execution === 'awaitable') {
    const { [BACKGROUND_PARAM]: background, [TIMEOUT_MINUTES_PARAM]: timeoutMinutes, ...own } = input.params
    params = own
    if (background !== true) {
      return { result: await run(params) }
    }
    timeoutMs = timeoutMsFrom(timeoutMinutes)
  } else if (execution !== 'async') {
    return { result: await run(params) }
  }
  const owner = taskOwner(caller)
  const record = await (await backgroundTaskService()).startInProcessTask({
    owner,
    ...task,
    timeoutMs,
    run: (signal) => run(params, signal),
  })
  return { started: taskStartedText(record, owner) }
}

// ── reading a task ───────────────────────────────────────────────────

// How many tasks one listing prints. A long session starts many, and every one
// of them lands in the caller's context; older ones stay reachable by id.
const LIST_LIMIT = 20

/** A duration the way a person reads one: `45s`, `12m 5s`, `2h 3m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  }
  return `${seconds}s`
}

function timeoutText(timeoutMs: number | null): string {
  return timeoutMs === null ? 'no time limit' : `times out after ${formatDuration(timeoutMs)}`
}

function instant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function stateText(record: BackgroundTaskRecord): string {
  const exit = record.exitCode === undefined ? '' : `, exit code ${record.exitCode}`
  const reason = record.reason ? ` — ${record.reason}` : ''
  return `${record.state}${exit}${reason}`
}

function timingText(record: BackgroundTaskRecord, now: Date): string {
  const started = `started ${instant(record.startedAt)}`
  if (record.state === 'running') {
    return `${started}, running for ${formatDuration(now.getTime() - record.startedAt.getTime())}`
  }
  if (record.finishedAt) {
    return `${started}, took ${formatDuration(record.finishedAt.getTime() - record.startedAt.getTime())}`
  }
  return started
}

/** One task in full, as task_status prints it. */
export function describeTask(record: BackgroundTaskRecord, now: Date): string {
  // A running task also says when it will be stopped; an ended one no longer has a deadline.
  const deadline = record.state === 'running' ? `; ${timeoutText(record.timeoutMs)}` : ''
  const lines = [
    `Task ${record.taskId}: ${stateText(record)}`,
    `${record.name} on ${record.target} — ${record.summary}`,
    `Timing: ${timingText(record, now)}${deadline}.`,
  ]
  // The tail is bounded by the service; the log is where the rest is, and it is
  // on the node the command ran on — the same target reaches it.
  if (record.logPath) {
    lines.push(`Full log: remote_read target="${record.target}" path="${record.logPath}"`)
  }
  const tail = record.outputTail?.trimEnd()
  if (tail) {
    lines.push('Output tail:', tail)
  } else {
    lines.push(record.state === 'running' ? 'No output yet.' : 'No output.')
  }
  return lines.join('\n')
}

/** A caller's own tasks, newest first, as task_status prints them without a taskId. */
export function describeTaskList(records: BackgroundTaskRecord[], owner: BackgroundTaskOwner, now: Date): string {
  const scope = owner.sessionId ? 'from this session' : `by ${owner.agent} outside a session`
  if (records.length === 0) {
    return `No background tasks were started ${scope}.`
  }
  const shown = records.slice(0, LIST_LIMIT)
  const lines = [`Background tasks started ${scope}, newest first:`]
  for (const record of shown) {
    lines.push(
      `${record.taskId} — ${stateText(record)} — ${record.name} on ${record.target}: ${record.summary} (${timingText(record, now)})`,
    )
  }
  if (records.length > shown.length) {
    lines.push(`… and ${records.length - shown.length} older, not shown.`)
  }
  lines.push("task_status with a taskId shows one task's output and log.")
  return lines.join('\n')
}

/**
 * What a cancel did, said as plainly as the service reported it. `requested` is
 * not `stopped`: an action handler inside this process can only be asked, and
 * one that ignores the request carries on — telling the caller it stopped would
 * be the one wrong answer here.
 */
export function cancelText(taskId: string, outcome: Exclude<CancelOutcome, 'unknown-task'>): string {
  switch (outcome) {
    case 'stopped':
      return `Stopped background task ${taskId}.`
    case 'requested':
      return (
        `Asked background task ${taskId} to stop. It is an action running inside this server, and one that ` +
        'does not honour the request runs on until it ends by itself — task_status shows whether it has stopped.'
      )
    case 'not-running':
      return `Background task ${taskId} had already ended; nothing was stopped. task_status shows how it ended.`
  }
}

function requireTaskId(args: Record<string, unknown>): string {
  const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : ''
  if (!taskId) {
    fail(-32602, 'Missing required param: taskId')
  }
  return taskId
}

function unknownTask(taskId: string): never {
  fail(-32602, `No background task has id "${taskId}".`)
}

export const definitions = [
  {
    name: 'task_status',
    description:
      'How background tasks are doing. With a taskId: that task’s state, when it started and how long it has run or took, its exit code or why it ended, the end of its output, and — for a command on a node — where its full log is. Without one: your own tasks, newest first. A background task is what remote_exec/remote_script with `background: true`, or an action that runs in the background, returns in place of a result.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The id a background call returned. Omit to list your own tasks.',
        },
      },
    },
  },
  {
    name: 'task_cancel',
    description:
      'Stop a background task. A command on a node is stopped; an action running inside this server is only asked to stop, and one that does not honour the request runs until it ends by itself — the reply says which happened. A task that has already ended is left as it was.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'The id a background call returned.' },
      },
      required: ['taskId'],
    },
  },
]

export const handlers: Record<string, ToolHandler> = {
  // ── task_status ──────────────────────────────────────────────────
  task_status: async (args, caller) => {
    if (args.taskId !== undefined) {
      const taskId = requireTaskId(args)
      const record = await (await backgroundTaskService()).get(taskId)
      if (!record) {
        unknownTask(taskId)
      }
      return textResult(describeTask(record, new Date()))
    }
    // "Your own tasks" needs a caller to own them. One with neither a session
    // nor an agent is every anonymous caller at once, and listing for it would
    // hand each of them the others' tasks.
    const owner = taskOwner(caller)
    if (!owner.sessionId && !owner.agent) {
      fail(
        -32602,
        'This caller has neither a session nor an agent identity, so it has no tasks of its own to list. ' +
          'Pass the taskId a background call returned.',
      )
    }
    const records = await (await backgroundTaskService()).listForOwner(owner)
    return textResult(describeTaskList(records, owner, new Date()))
  },

  // ── task_cancel ──────────────────────────────────────────────────
  //
  // Gated like every other tool that changes something: stopping a deploy
  // half-way is a change, whoever started it.
  task_cancel: withApprovalRequired(async (args) => {
    const taskId = requireTaskId(args)
    const outcome = await (await backgroundTaskService()).cancel(taskId)
    if (outcome === 'unknown-task') {
      unknownTask(taskId)
    }
    return textResult(cancelText(taskId, outcome))
  }),
}
