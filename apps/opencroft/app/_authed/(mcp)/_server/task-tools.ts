/**
 * The background-task family: running a call as a background task on a
 * caller's behalf, and the two tools that ask how one is doing and stop one.
 *
 * A background task is a call the caller did not wait for: one to a tool or an
 * action declared `async`, or declared `awaitable` and called with
 * `background: true`. The service in (background-tasks) owns everything after
 * the start — the record, watching the work, the timeout, and telling the
 * calling conversation how it ended. What lives here is the tool side of that:
 * reading a declaration to decide how a call runs, turning a call into a start,
 * and a record into text.
 *
 * NO HANDLER TAKES PART. A handler is written to run in place — it takes its
 * arguments and returns its result or throws — and a task runs that same
 * handler, whose answer becomes the task's result. It never sees a task id,
 * never starts a task, never says that one started: the id exists only between
 * the platform and the caller. That is what lets a declaration alone put any
 * tool or action in the background.
 */

import type { ExecutionMode } from '@opencroft/core'

import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import { isAppAddress } from '@/app/_authed/(apps)/_server/app-address'
import type {
  BackgroundTaskOwner,
  BackgroundTaskRecord,
  BackgroundTaskService,
  CancelOutcome,
  StartRunnerTaskInput,
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
 * The one line a task is known by: the caller's own description of it, or
 * failing that the first line of `fallback` — a command's, or what a tool's
 * name and target say.
 */
export function taskSummary(description: unknown, fallback: string): string {
  if (typeof description === 'string' && description.trim()) {
    return description.trim()
  }
  const firstLine = fallback.split('\n').find((line) => line.trim()) ?? ''
  return firstLine.trim()
}

/**
 * What a call that started a task answers with, in place of a result — one
 * wording for every tool and every action.
 *
 * With a session it says only that the result will come, because it will: the
 * service delivers it into the conversation when the task ends. Naming
 * task_status or task_cancel here reads as an invitation, and an agent that
 * takes it spends a turn checking on a task it has just started — if the start
 * did not fail, the task is running. Without a session — an MCP client over
 * HTTP — nothing will ever arrive, so the answer says so and hands over the one
 * way that caller learns the result: polling by id. Implying otherwise would
 * leave it waiting for good.
 */
export function taskStartedText(record: BackgroundTaskRecord, owner: BackgroundTaskOwner): string {
  const summary = record.summary.trim()
  const head = summary
    ? `Started background task ${record.taskId} — ${/[.!?]$/.test(summary) ? summary : `${summary}.`}`
    : `Started background task ${record.taskId}.`
  if (owner.sessionId) {
    return `${head} Its result will arrive in this conversation when it ends.`
  }
  // The one caller told about task_status: with no session nothing will
  // arrive, so polling is the only way it ever learns the result. Nothing
  // else is suggested -- a hint to check on or stop a task just started only
  // invites a turn spent doing so.
  return (
    `${head} No notification will arrive: this caller has no session. ` +
    `Poll task_status with taskId "${record.taskId}" for its state and output.`
  )
}

/** How one call runs: in place, or as a task with this limit. */
export type CallRoute =
  | { background: false; args: Record<string, unknown> }
  | { background: true; args: Record<string, unknown>; timeoutMs: number | null }

/**
 * How one call runs, by what its tool or action declares — the one decision
 * every tool, `call` and `app_call` share, so `background` means the same
 * thing wherever a caller passes it.
 *
 * `async` is always a task, under the default limit: its schema offered no
 * `timeoutMinutes`, so none is read, and nothing is taken out of arguments
 * that are all the tool's own. `awaitable` is a task when the caller passed
 * `background: true` — the boolean; the string "true" is a caller's slip, not
 * its choice — and either way `background` and `timeoutMinutes` belong to the
 * host, because the listing offered them, so they come out before the handler
 * sees the arguments. Anything else, `sync` or a mode nobody declared, runs in
 * place with its arguments untouched: a sync tool that takes a parameter
 * called `background` owns it.
 *
 * A malformed timeout throws from here, so it is refused as the bad argument
 * it is before anything has been claimed, started or run.
 */
export function routeCall(execution: ExecutionMode | undefined, args: Record<string, unknown>): CallRoute {
  if (execution === 'async') {
    return { background: true, args, timeoutMs: DEFAULT_TIMEOUT_MINUTES * 60_000 }
  }
  if (execution !== 'awaitable') {
    return { background: false, args }
  }
  const { [BACKGROUND_PARAM]: background, [TIMEOUT_MINUTES_PARAM]: timeoutMinutes, ...own } = args
  if (background !== true) {
    return { background: false, args: own }
  }
  return { background: true, args: own, timeoutMs: timeoutMsFrom(timeoutMinutes) }
}

// ── tools ────────────────────────────────────────────────────────────

/**
 * What a tool's runner adapter answers with: the command the background task
 * runner is to leave running, where, and what the task is known by. Who it is
 * for, the tool's name and the time limit are the registry's to add — an
 * adapter starts nothing itself.
 */
export type RunnerCommand = Omit<StartRunnerTaskInput, 'owner' | 'name' | 'timeoutMs'>

/**
 * A tool's way onto the background task runner (EXPERIMENTAL): a command left
 * detached on the node itself, which outlives this server and keeps its whole
 * log there. Optional, and rare — only work that has to survive a restart or be
 * followed live needs it. A tool without one runs in the background as an
 * in-process task, which asks nothing of the tool at all.
 *
 * It is handed the call as the tool's handler would be, `background` and
 * `timeoutMinutes` already taken out, and has to refuse what that handler
 * refuses and claim what it claims before it names a command: a command run in
 * the background is still one somebody approved, and still a write.
 */
export type BackgroundRunnerAdapter = (
  args: Record<string, unknown>,
  caller: ToolCallerContext,
) => Promise<RunnerCommand>

/**
 * A tool's own call, as the registry makes it — the static handler, the
 * extension's, or the agent-tool node's. `signal` is passed only when the call
 * runs as a background task.
 */
export type ToolRun = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>

/**
 * What a backgrounded tool call runs against, for display: the terminal
 * target, node or app address its arguments name, or '' when they name none.
 * An app named by its uuid shows as nothing rather than as the uuid — the
 * address is what a reader knows it by, and what `app_call` lists a task under.
 */
export function toolTaskTarget(args: Record<string, unknown>): string {
  for (const value of [args.target, args.nodeId]) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return typeof args.app === 'string' && isAppAddress(args.app) ? args.app : ''
}

/**
 * A tool's answer as its task's result: the text it would have answered a
 * caller with, verbatim, so the handler's ordinary output is the result and
 * nothing is written for the task's sake. An answer flagged `isError` fails the
 * task with that text as the reason — what the caller would have read in place.
 * Content that is not text, an image, has no place in a task's result.
 */
export function taskResultOf(result: Record<string, unknown>): string {
  const parts = Array.isArray(result.content) ? (result.content as { type?: unknown; text?: unknown }[]) : []
  const text = parts
    .flatMap((part) => (part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('\n')
  if (result.isError === true) {
    throw new Error(text || 'The tool reported an error without a message.')
  }
  return text
}

/**
 * Run one tool call the way its declaration says a caller waits for it — the
 * decorator the registry puts around every tool it dispatches, static,
 * extension-contributed or graph-defined, once the call is approved.
 *
 * In place the answer is the tool's own. In the background the answer is the
 * task that started, and the same call is that task's work: through the tool's
 * runner adapter when it registered one, otherwise in this process, where what
 * the call answers with becomes the task's result (see `taskResultOf`).
 */
export async function callTool(input: {
  name: string
  execution: ExecutionMode | undefined
  args: Record<string, unknown>
  caller: ToolCallerContext
  run: ToolRun
  runner?: BackgroundRunnerAdapter
}): Promise<Record<string, unknown>> {
  const { name, caller, run, runner } = input
  const route = routeCall(input.execution, input.args)
  if (!route.background) {
    return run(route.args)
  }
  const { args, timeoutMs } = route
  const owner = taskOwner(caller)
  let record: BackgroundTaskRecord
  if (runner) {
    // The adapter's checks run before the service is asked: a call they
    // refuse leaves no record behind.
    const command = await runner(args, caller)
    record = await (await backgroundTaskService()).startRunnerTask({ ...command, owner, name, timeoutMs })
  } else {
    const target = toolTaskTarget(args)
    record = await (await backgroundTaskService()).startInProcessTask({
      owner,
      kind: 'tool',
      name,
      target,
      summary: taskSummary(args.description, target ? `${name} on ${target}` : name),
      timeoutMs,
      run: async (signal) => taskResultOf(await run(args, signal)),
    })
  }
  return textResult(taskStartedText(record, owner))
}

// ── actions ──────────────────────────────────────────────────────────

/** What an action call came to: its result, or the answer for the task started in its place. */
export type ActionOutcome = { result: unknown } | { started: string }

/**
 * Run one action the way its declaration says a caller waits for it — the part
 * of `call` and `app_call` that is the same for both, and the same as every
 * tool's: one routing (`routeCall`), one answer on a start (`taskStartedText`).
 * An action always runs in this process when it runs in the background.
 */
export async function callAction(input: {
  execution: ExecutionMode | undefined
  params: Record<string, unknown>
  caller: ToolCallerContext
  task: { kind: 'node-action' | 'app-action'; name: string; target: string; summary: string }
  run: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
}): Promise<ActionOutcome> {
  const { caller, task, run } = input
  const route = routeCall(input.execution, input.params)
  if (!route.background) {
    return { result: await run(route.args) }
  }
  const { args, timeoutMs } = route
  const owner = taskOwner(caller)
  const record = await (await backgroundTaskService()).startInProcessTask({
    owner,
    ...task,
    timeoutMs,
    run: (signal) => run(args, signal),
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

/**
 * What ran, and the summary when it says more than that. A call with nothing
 * to run against has no " on …"; a task started without a description is
 * summarised by its tool's name and target, and saying those twice would only
 * lengthen the line.
 */
function headline(record: BackgroundTaskRecord, separator: string): string {
  const ran = record.target ? `${record.name} on ${record.target}` : record.name
  return record.summary && record.summary !== ran ? `${ran}${separator}${record.summary}` : ran
}

/**
 * What a task has to show for itself. A command on the runner writes a log,
 * which the service keeps the END of, and whose whole lives on the node — the
 * same target reaches it. Work in this process answers once, and what the
 * service keeps is that answer: its result.
 */
function outputLines(record: BackgroundTaskRecord): string[] {
  const kept = record.outputTail?.trimEnd()
  const running = record.state === 'running'
  if (record.runner === 'background-task-runner') {
    const log = record.logPath ? [`Full log: remote_read target="${record.target}" path="${record.logPath}"`] : []
    if (kept) {
      return [...log, 'Output (the end of it):', kept]
    }
    return [...log, running ? 'No output yet.' : 'No output.']
  }
  if (kept) {
    return ['Result:', kept]
  }
  return [running ? 'No result yet.' : 'No result.']
}

/** One task in full, as task_status prints it. */
export function describeTask(record: BackgroundTaskRecord, now: Date): string {
  // A running task also says when it will be stopped; an ended one no longer has a deadline.
  const deadline = record.state === 'running' ? `; ${timeoutText(record.timeoutMs)}` : ''
  return [
    `Task ${record.taskId}: ${stateText(record)}`,
    headline(record, ' — '),
    `Timing: ${timingText(record, now)}${deadline}.`,
    ...outputLines(record),
  ].join('\n')
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
    lines.push(`${record.taskId} — ${stateText(record)} — ${headline(record, ': ')} (${timingText(record, now)})`)
  }
  if (records.length > shown.length) {
    lines.push(`… and ${records.length - shown.length} older, not shown.`)
  }
  lines.push('task_status with a taskId shows one task in full.')
  return lines.join('\n')
}

/**
 * What a cancel did, said as plainly as the service reported it. `requested` is
 * not `stopped`: work running inside this process — a tool's handler or an
 * action's — can only be asked, and one that ignores the request carries on;
 * telling the caller it stopped would be the one wrong answer here.
 */
export function cancelText(taskId: string, outcome: Exclude<CancelOutcome, 'unknown-task'>): string {
  switch (outcome) {
    case 'stopped':
      return `Stopped background task ${taskId}.`
    case 'requested':
      return (
        `Asked background task ${taskId} to stop. It runs inside this server, and work that ` +
        'does not honour the request runs on until it ends by itself — task_status shows whether it has stopped.'
      )
    case 'not-running':
      return `Background task ${taskId} had already ended; nothing was stopped.`
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
      'How background tasks are doing. With a taskId: that task’s state, when it started and how long it has run or took, its exit code or why it ended, and its result — for a command on a node, the end of its output and where its full log is. Without one: your own tasks, newest first. A background task is what a call returns in place of a result when it runs in the background: a tool or action called with `background: true`, or one that always runs that way.',
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
      'Stop a background task. A command on a node is stopped. Work running inside this server, a tool or an action, is only asked to stop, and if it does not honour the request it runs until it ends by itself; the reply says which happened and shows the task as it now stands. Cancelling a task your own session started sends no separate notice of its ending: the reply is that notice. A task that has already ended is left as it was.',
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
  //
  // The reply carries the task as the cancel left it. For the session that
  // started the task this reply is the only word of its ending: the service
  // sends that session no notification for an ending it asked for.
  task_cancel: withApprovalRequired(async (args, caller) => {
    const taskId = requireTaskId(args)
    const service = await backgroundTaskService()
    const outcome = await service.cancel(taskId, taskOwner(caller))
    if (outcome === 'unknown-task') {
      unknownTask(taskId)
    }
    const record = await service.get(taskId)
    const reply = cancelText(taskId, outcome)
    return textResult(record ? `${reply}\n\n${describeTask(record, new Date())}` : reply)
  }),
}
