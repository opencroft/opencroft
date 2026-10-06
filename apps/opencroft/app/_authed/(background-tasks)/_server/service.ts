/**
 * The background-task service: everything after a start. It keeps the durable
 * record (store.ts), runs the work — as a handler nobody awaits
 * (in-process-runner.ts), or, for a tool that opted in, detached on a node by
 * the background task runner (background-task-runner.ts, EXPERIMENTAL) —
 * watches it, times it out, stops it, and tells the calling session how it
 * ended (delivery.ts). types.ts is the contract the tools that start tasks are
 * written against.
 *
 * What ran — a tool, an app action, a node action — decides nothing here. How
 * it runs decides everything: only a runner task has a node to probe, a launch
 * that can still be under way, and a process a restart does not end.
 *
 * The poller (server/scheduler/background-task-poller.ts) drives the watching:
 * `probe`, `enforceDeadlines`, `deliverOwed`, `housekeep`, and `sweepOrphans`
 * once at startup. Each may be called while its previous call is still going.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { dataDir } from '@/server/data-dir'
import {
  BackgroundTaskRunner,
  endingOf,
  isTaskDir,
  type Launched,
  type ProbeReport,
  type RunnerTransport,
} from './background-task-runner'
import { createDeliveryState, Delivery, type DeliveryState } from './delivery'
import { type HostTaskEngine, hostTaskEngine } from './engine'
import { InFlight } from './in-flight'
import { describeResult, InProcessRunner, type Settled } from './in-process-runner'
import { formatLimit, LOG_RETENTION_DAYS } from './notification'
import { createRunningKeysState, RunningKeys, type RunningKeysState } from './running-keys'
import {
  clearNodeDirs,
  deleteEndedBefore,
  type Ending,
  finishTask,
  getTask,
  insertTask,
  owedTasks,
  recentTasks,
  removableDirs,
  runningTasks,
  sessionlessTasks,
  type TaskRow,
  tasksForSessionId,
  tasksForSessionKey,
  toRecord,
  updateTask,
} from './store'
import type {
  BackgroundTaskKind,
  BackgroundTaskOwner,
  BackgroundTaskRecord,
  BackgroundTaskService,
  CancelOutcome,
  StartInProcessTaskInput,
  StartRunnerTaskInput,
} from './types'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

/**
 * How long an ended task is still worth telling its session about. Past it the
 * task stays owed — nothing reached the session — but nobody is asked any more:
 * a conversation that has not come back in a week is not waiting for it.
 */
const DELIVERY_HORIZON_MS = 7 * DAY_MS
/** Rows of ended tasks are dropped this long after they ended. */
const ROW_RETENTION_MS = 30 * DAY_MS
/** A launch takes seconds; a runner task this long without a directory died half-way through starting. */
const LAUNCH_GRACE_MS = 5 * MINUTE_MS
/** A node that refused a housekeeping removal is not asked again for this long. */
const REMOVE_RETRY_MS = 60 * MINUTE_MS
const HOUSEKEEPING_EVERY_MS = 10 * MINUTE_MS
/** The audit list: everything running, and what ended in the last day. */
const RECENT_MS = DAY_MS
const RECENT_LIMIT = 50

export const SERVER_RESTARTED = 'server restarted'

export interface ServiceDeps {
  /** Which process registry this is — see the schema's comment on `instanceId`. */
  instanceId: () => string
  transport: () => Promise<RunnerTransport>
  engine: () => Promise<HostTaskEngine>
  /** Resume or reuse the session a key belongs to — never create one. Null when nothing claims the key. */
  openSession: (sessionKey: string) => Promise<{ sessionId: string } | null>
  now?: () => Date
}

/**
 * What the service holds in memory, apart from the service so it can outlive a
 * reload of this module: an abort handle, or the fact that a session was
 * already told, belongs to the process rather than to one evaluation of code.
 */
export interface ServiceState {
  /** In-process tasks' abort handles, by task id. */
  controllers: Map<string, AbortController>
  keys: RunningKeysState
  delivery: DeliveryState
  inFlight: Set<string>
  reported: Set<string>
  removeRetryAt: Map<string, number>
  housekeptAt: number
}

export function createState(): ServiceState {
  return {
    controllers: new Map(),
    keys: createRunningKeysState(),
    delivery: createDeliveryState(),
    inFlight: new Set(),
    reported: new Set(),
    removeRetryAt: new Map(),
    housekeptAt: 0,
  }
}

/**
 * When a task times out, from what is stored — so a restart neither resets a
 * deadline nor forgets one. Null: no limit.
 */
export function deadlineOf(task: { startedAt: Date; timeoutMs: number | null }): number | null {
  return task.timeoutMs === null ? null : task.startedAt.getTime() + task.timeoutMs
}

// The remote tools fail with a plain `{ code, message }` rather than an Error,
// and String() of that is "[object Object]".
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : String(error)
}

function groupByTarget(rows: TaskRow[]): Map<string, TaskRow[]> {
  const groups = new Map<string, TaskRow[]>()
  for (const row of rows) {
    groups.set(row.target, [...(groups.get(row.target) ?? []), row])
  }
  return groups
}

/**
 * Whether the background task runner runs this task, on a node — the one
 * question every probe, stop, deadline and sweep below turns on. Never read off
 * the kind: a tool's task is in-process unless its tool opted in.
 */
function onRunner(row: TaskRow): boolean {
  return row.runner === 'background-task-runner'
}

interface StartRecord {
  taskId: string
  owner: BackgroundTaskOwner
  kind: BackgroundTaskKind
  // Named by its field, not by the type: the runner's class has the type's name.
  runner: BackgroundTaskRecord['runner']
  name: string
  target: string
  summary: string
  timeoutMs: number | null
}

export class BackgroundTasks implements BackgroundTaskService {
  private readonly guard: InFlight
  private readonly keys: RunningKeys
  private readonly delivery: Delivery
  private readonly inProcess: InProcessRunner

  constructor(
    private readonly state: ServiceState,
    private readonly deps: ServiceDeps,
  ) {
    const now = () => this.now()
    this.guard = new InFlight(state.inFlight, state.reported)
    this.keys = new RunningKeys(state.keys, { load: () => runningTasks(deps.instanceId()), now, guard: this.guard })
    this.delivery = new Delivery(state.delivery, { ...deps, now, guard: this.guard })
    this.inProcess = new InProcessRunner(state.controllers)
  }

  // ── starting ─────────────────────────────────────────────────────────

  /**
   * EXPERIMENTAL: a tool's command, detached on its node by the background
   * task runner — see background-task-runner.ts for what that asks of the node
   * and what it does not do yet. Only a tool that opted in starts one.
   */
  async startRunnerTask(input: StartRunnerTaskInput): Promise<BackgroundTaskRecord> {
    // The row goes in before anything runs: a registry that cannot record a
    // task refuses it, rather than leaving a process running untracked.
    const record = await this.recordStart({
      ...input,
      taskId: randomUUID(),
      kind: 'tool',
      runner: 'background-task-runner',
    })
    let launched: Launched
    try {
      launched = await (await this.runner()).launch({ ...input, taskId: record.taskId })
    } catch (error) {
      // The caller hears this from the throw, so the task ends already told:
      // a notification would only repeat what the tool call has just said.
      const ending: Ending = {
        state: 'failed',
        reason: `it did not start: ${messageOf(error)}`,
        deliveredAt: this.now(),
      }
      await this.end(record.taskId, ending).catch((endError: unknown) =>
        this.guard.logOnce(`end:${record.taskId}`, 'could not record a failed start', endError),
      )
      throw error
    }
    await updateTask(record.taskId, { nodeDir: launched.dir, pid: launched.pid, logPath: launched.logPath })
    const started = { ...record, logPath: launched.logPath }
    this.keys.track(started.taskId, started.sessionKey)
    void this.delivery.show(started)
    return started
  }

  /** A tool's or an action's handler, run in this process and not awaited: the default way a task runs. */
  async startInProcessTask(input: StartInProcessTaskInput): Promise<BackgroundTaskRecord> {
    const taskId = randomUUID()
    this.inProcess.register(taskId)
    let record: BackgroundTaskRecord
    try {
      record = await this.recordStart({ ...input, taskId, runner: 'in-process' })
    } catch (error) {
      this.inProcess.forget(taskId)
      throw error
    }
    this.keys.track(taskId, record.sessionKey)
    // Shown before the work starts: a handler that settles at once must not
    // have its ending overtaken by the record saying it runs.
    await this.delivery.show(record)
    this.inProcess.run(taskId, input.run, (settled) => void this.settle(taskId, settled))
    return record
  }

  private async recordStart(input: StartRecord): Promise<BackgroundTaskRecord> {
    const sessionKey = await this.sessionKeyOf(input.owner)
    const startedAt = this.now()
    await insertTask({
      taskId: input.taskId,
      instanceId: this.deps.instanceId(),
      agent: input.owner.agent,
      sessionKey: sessionKey ?? null,
      sessionId: input.owner.sessionId ?? null,
      kind: input.kind,
      runner: input.runner,
      name: input.name,
      target: input.target,
      summary: input.summary,
      state: 'running',
      startedAt,
      timeoutMs: input.timeoutMs,
    })
    return {
      taskId: input.taskId,
      agent: input.owner.agent,
      sessionKey,
      kind: input.kind,
      runner: input.runner,
      name: input.name,
      target: input.target,
      summary: input.summary,
      state: 'running',
      startedAt,
      timeoutMs: input.timeoutMs,
    }
  }

  private async settle(taskId: string, settled: Settled): Promise<void> {
    const ending: Ending = settled.ok
      ? { state: 'completed', outputTail: describeResult(settled.value) }
      : { state: 'failed', reason: messageOf(settled.error) }
    // A handler that was cancelled or timed out has ended already; this write
    // then finds nothing running and changes nothing.
    await this.end(taskId, ending).catch((error: unknown) =>
      this.guard.logOnce(`end:${taskId}`, `could not record how task ${taskId} ended`, error),
    )
  }

  // ── reading ──────────────────────────────────────────────────────────

  async get(taskId: string): Promise<BackgroundTaskRecord | null> {
    const row = await getTask(this.deps.instanceId(), taskId)
    return row ? toRecord(row) : null
  }

  async listForOwner(owner: BackgroundTaskOwner): Promise<BackgroundTaskRecord[]> {
    const instanceId = this.deps.instanceId()
    if (!owner.sessionId) {
      return (await sessionlessTasks(instanceId, owner.agent)).map(toRecord)
    }
    // By key while the session still has one here, so the list covers its
    // earlier lives too; by the id it had at the start otherwise.
    const sessionKey = await this.sessionKeyOf(owner)
    const rows = sessionKey
      ? await tasksForSessionKey(instanceId, sessionKey)
      : await tasksForSessionId(instanceId, owner.sessionId)
    return rows.map(toRecord)
  }

  async listRunning(): Promise<BackgroundTaskRecord[]> {
    return (await runningTasks(this.deps.instanceId())).map(toRecord)
  }

  /** Everything running, and what ended in the last day: newest first, at most 50. */
  async listRecent(): Promise<BackgroundTaskRecord[]> {
    const endedAfter = new Date(this.now().getTime() - RECENT_MS)
    return (await recentTasks(this.deps.instanceId(), endedAfter, RECENT_LIMIT)).map(toRecord)
  }

  runningSessionKeys(): ReadonlySet<string> {
    return this.keys.sessionKeys()
  }

  subscribeRunningSessionKeys(listener: () => void): () => void {
    return this.keys.subscribe(listener)
  }

  /** Read the running tasks' keys now rather than on first use — at startup. */
  loadRunningKeys(): void {
    this.keys.load()
  }

  // ── stopping ─────────────────────────────────────────────────────────

  async cancel(taskId: string, by?: BackgroundTaskOwner): Promise<CancelOutcome> {
    const row = await getTask(this.deps.instanceId(), taskId)
    if (!row) {
      return 'unknown-task'
    }
    if (row.state !== 'running') {
      return 'not-running'
    }
    // A notification to the session that is asking would arrive while its own
    // call is still out, and a harness that takes mid-turn input aborts that
    // call to deliver it.
    const toldInReply = await this.isOwnSession(row, by)
    if (onRunner(row)) {
      return this.stopOnNode(row, 'cancelled', toldInReply)
    }
    if (!this.inProcess.abort(taskId, 'cancelled')) {
      // Running by its row, but not in this process: a previous process's
      // handler, gone with it.
      await this.end(taskId, { state: 'failed', reason: SERVER_RESTARTED }, toldInReply)
      return 'not-running'
    }
    return (await this.end(taskId, { state: 'stopped', reason: 'cancelled' }, toldInReply))
      ? 'requested'
      : 'not-running'
  }

  /** A stop pressed in the chat, answered the way the chat asks: was it taken. */
  async requestStop(taskId: string): Promise<boolean> {
    const outcome = await this.cancel(taskId)
    return outcome === 'stopped' || outcome === 'requested'
  }

  /** Stop a runner task's process group on its node. `toldInReply`: see `end`. */
  private async stopOnNode(row: TaskRow, reason: string, toldInReply = false): Promise<CancelOutcome> {
    const dir = row.nodeDir
    if (!dir) {
      // Stopped before its launch recorded a directory: nothing on the node to signal.
      return (await this.end(row.taskId, { state: 'stopped', reason }, toldInReply)) ? 'stopped' : 'not-running'
    }
    // Held for the probe, which would otherwise read the process this stop has
    // just killed as one that vanished on its own.
    return this.guard.hold(`stop:${row.taskId}`, async () => {
      let report: ProbeReport | null
      try {
        report = await (await this.runner()).stop(row.target, { taskId: row.taskId, dir })
      } catch (error) {
        // Let go of it anyway. A stop nobody can deliver must still end the
        // task for its session, or an unreachable node would keep that session
        // working for as long as the node stays away.
        const unreached = `${reason}; the node could not be reached to stop the process (${messageOf(error)})`
        const ending: Ending = { state: 'stopped', reason: unreached }
        return (await this.end(row.taskId, ending, toldInReply)) ? 'requested' : 'not-running'
      }
      if (report?.status === 'exited') {
        // It ended on its own just before the stop reached it.
        await this.end(row.taskId, endingOf(report), toldInReply)
        return 'not-running'
      }
      if (report?.status === 'running') {
        const survived = `${reason}; the process was still running after SIGKILL`
        const ending: Ending = { state: 'stopped', reason: survived }
        return (await this.end(row.taskId, ending, toldInReply)) ? 'requested' : 'not-running'
      }
      const outputTail = report?.status === 'vanished' ? report.tail || undefined : undefined
      const ending: Ending = { state: 'stopped', reason, outputTail }
      return (await this.end(row.taskId, ending, toldInReply)) ? 'stopped' : 'not-running'
    })
  }

  // ── ending ───────────────────────────────────────────────────────────

  /**
   * Record the ending, if nothing beat this to it, and tell the session.
   * `toldInReply`: the session asked for this ending and reads it in its own
   * reply, so the ending is recorded as told and only the session's record of
   * the task is brought up to date. An ending something else beat this to is
   * told as usual.
   */
  private async end(taskId: string, ending: Ending, toldInReply = false): Promise<BackgroundTaskRecord | null> {
    const now = this.now()
    const row = await finishTask(taskId, toldInReply ? { ...ending, deliveredAt: now } : ending, now)
    this.keys.untrack(taskId)
    if (!row) {
      return null
    }
    const record = toRecord(row)
    if (toldInReply) {
      void this.delivery.show(record)
    } else if (!record.deliveredAt) {
      void this.delivery.deliver(record)
    }
    return record
  }

  /** Whether `by` is the session a task tells: the one that started it, by id or by the key it outlives restarts under. */
  private async isOwnSession(row: TaskRow, by: BackgroundTaskOwner | undefined): Promise<boolean> {
    if (!by?.sessionId || !row.sessionKey) {
      return false
    }
    return row.sessionId === by.sessionId || row.sessionKey === (await this.sessionKeyOf(by))
  }

  /** See Delivery.sync: called whenever the host opens a session behind a key. */
  syncSession(sessionKey: string, sessionId: string): Promise<void> {
    return this.delivery.sync(sessionKey, sessionId)
  }

  // ── what the poller drives ───────────────────────────────────────────

  /**
   * Ask each node how its runner tasks are: one exec per target. An in-process
   * task has no node to ask — whatever its kind — and is never probed.
   */
  async probe(): Promise<void> {
    const now = this.now().getTime()
    const rows = (await runningTasks(this.deps.instanceId())).filter(onRunner)
    const probed: TaskRow[] = []
    for (const row of rows) {
      if (row.nodeDir) {
        probed.push(row)
      } else if (now - row.startedAt.getTime() > LAUNCH_GRACE_MS) {
        await this.end(row.taskId, { state: 'failed', reason: 'it never finished starting' })
      }
    }
    const targets = [...groupByTarget(probed)]
    await Promise.all(
      targets.map(([target, group]) => this.guard.once(`probe:${target}`, () => this.probeTarget(target, group))),
    )
  }

  private async probeTarget(target: string, rows: TaskRow[]): Promise<void> {
    let reports: Map<string, ProbeReport>
    try {
      const refs = rows.map((row) => ({ taskId: row.taskId, dir: row.nodeDir as string }))
      reports = await (await this.runner()).probe(target, refs)
    } catch (error) {
      this.guard.logOnce(`probe:${target}`, `could not probe ${target}; its tasks stay running until it answers`, error)
      return
    }
    this.guard.recovered(`probe:${target}`)
    for (const row of rows) {
      const report = reports.get(row.taskId)
      if (report && report.status !== 'running' && !this.guard.has(`stop:${row.taskId}`)) {
        await this.end(row.taskId, endingOf(report))
      }
    }
  }

  async enforceDeadlines(): Promise<void> {
    const now = this.now().getTime()
    const due = (await runningTasks(this.deps.instanceId())).filter((row) => {
      const deadline = deadlineOf(row)
      // A runner task still launching has no directory to stop yet, and
      // stopping its record now would leave what the launch starts running
      // untracked. An in-process task is never launching: it had no directory
      // to wait for.
      const launching = onRunner(row) && !row.nodeDir
      return deadline !== null && deadline <= now && !launching && !this.guard.has(`stop:${row.taskId}`)
    })
    await Promise.all(due.map((row) => this.timeOut(row)))
  }

  private async timeOut(row: TaskRow): Promise<void> {
    const reason = `timed out after ${formatLimit(row.timeoutMs as number)}`
    if (onRunner(row)) {
      await this.stopOnNode(row, reason)
      return
    }
    if (!this.inProcess.abort(row.taskId, reason)) {
      await this.end(row.taskId, { state: 'failed', reason: SERVER_RESTARTED })
      return
    }
    await this.end(row.taskId, { state: 'stopped', reason })
  }

  /** Tell every session still owed an ending — including ones a previous process never got to. */
  async deliverOwed(): Promise<void> {
    const endedAfter = new Date(this.now().getTime() - DELIVERY_HORIZON_MS)
    const rows = await owedTasks(this.deps.instanceId(), endedAfter)
    await Promise.all(rows.map((row) => this.delivery.deliver(toRecord(row))))
  }

  /**
   * Fail every in-process task this process is not running — a tool's as much
   * as an action's. Run at startup, where each one is a previous process's
   * handler that died with it: nothing is left to finish it, and waiting would
   * keep its session working forever. A runner task is left to the probe: its
   * process is on its node, and a restart here did not end it.
   */
  async sweepOrphans(): Promise<void> {
    const rows = await runningTasks(this.deps.instanceId())
    for (const row of rows) {
      if (!onRunner(row) && !this.inProcess.has(row.taskId)) {
        await this.end(row.taskId, { state: 'failed', reason: SERVER_RESTARTED })
      }
    }
  }

  /**
   * Remove task directories from their nodes once no longer wanted, and drop
   * old rows. At most every ten minutes: nothing here is urgent.
   */
  async housekeep(): Promise<void> {
    const now = this.now().getTime()
    if (now < this.state.housekeptAt + HOUSEKEEPING_EVERY_MS) {
      return
    }
    this.state.housekeptAt = now
    await this.guard.once('housekeeping', async () => {
      const rows = await removableDirs(this.deps.instanceId(), {
        deliveredBefore: new Date(now - LOG_RETENTION_DAYS * DAY_MS),
        endedBefore: new Date(now - DELIVERY_HORIZON_MS),
      })
      await Promise.all([...groupByTarget(rows)].map(([target, group]) => this.removeDirs(target, group, now)))
      await deleteEndedBefore(this.deps.instanceId(), new Date(now - ROW_RETENTION_MS))
    })
  }

  private async removeDirs(target: string, rows: TaskRow[], now: number): Promise<void> {
    if (now < (this.state.removeRetryAt.get(target) ?? 0)) {
      return
    }
    // A path that is not one of this runner's never reaches `rm`; its row just
    // stops pointing at it.
    const dirs = rows.filter((row) => isTaskDir(row.nodeDir as string, row.taskId)).map((row) => row.nodeDir as string)
    try {
      if (dirs.length > 0) {
        await (await this.runner()).remove(target, dirs)
      }
    } catch (error) {
      this.state.removeRetryAt.set(target, now + REMOVE_RETRY_MS)
      this.guard.logOnce(`remove:${target}`, `could not remove ended task directories on ${target}`, error)
      return
    }
    this.guard.recovered(`remove:${target}`)
    await clearNodeDirs(rows.map((row) => row.taskId))
  }

  // ── plumbing ─────────────────────────────────────────────────────────

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private async runner(): Promise<BackgroundTaskRunner> {
    return new BackgroundTaskRunner(await this.deps.transport())
  }

  private async sessionKeyOf(owner: BackgroundTaskOwner): Promise<string | undefined> {
    if (!owner.sessionId) {
      return undefined
    }
    const engine = await this.deps.engine()
    return engine.listSessions().find((session) => session.id === owner.sessionId)?.sessionKey
  }
}

// ── this process's service ─────────────────────────────────────────────

let instance: string | undefined

/**
 * This instance's registry id: made once and kept on the instance's own data
 * volume, which is per-instance by construction — unlike the database, which
 * several deployments can share.
 */
function instanceIdFromDataDir(): string {
  if (instance) {
    return instance
  }
  const file = dataDir('background-tasks-instance')
  try {
    instance = readFileSync(file, 'utf8').trim() || undefined
  } catch {
    // First use on this volume.
  }
  if (!instance) {
    instance = randomUUID()
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(file, `${instance}\n`)
  }
  return instance
}

const globalForTasks = globalThis as unknown as { __BACKGROUND_TASKS__?: ServiceState }
globalForTasks.__BACKGROUND_TASKS__ ??= createState()

// The engine, the session opener and the remote tools are loaded on use, never
// imported. Each of them comes back round to modules that import this one — the
// tools that start tasks, the host that reads the running keys — so this module
// must load from anywhere in those graphs without needing any of them loaded.
export const backgroundTasks = new BackgroundTasks(globalForTasks.__BACKGROUND_TASKS__, {
  instanceId: instanceIdFromDataDir,
  transport: async () => (await import('./remote-transport')).remoteToolsTransport,
  engine: async () => hostTaskEngine((await import('@/app/_authed/(agent)/_server/agent-client-instance')).agentClient),
  openSession: async (sessionKey) =>
    (await import('@/app/_authed/(extension-runtime)/_server/stream')).wakeSessionByKey(sessionKey),
})
