/**
 * THE BACKGROUND TASK RUNNER. EXPERIMENTAL.
 *
 * Not how a background task runs by default: that is the handler's own promise,
 * run in this process and not awaited (in-process-runner.ts), and it ends with
 * the process. This is the opt-in for a tool whose work has to survive a
 * restart of the server and keep a live log on the node: the command is
 * detached ON THE NODE, so neither the one-shot exec cap nor this process's
 * lifetime bounds it, and it is watched afterwards through the files it leaves
 * in a directory of its own there.
 *
 * Everything here is shell text built on this side and run through the
 * transport the remote tools provide (remote-transport.ts), against a target
 * resolved the way they resolve it — so a task lands on exactly the machine, as
 * exactly the user, that a synchronous `remote_exec` on the same target would
 * have. The command itself runs under the same shell too (see `buildProgram`).
 *
 * WHAT IT NEEDS FROM THE NODE: a POSIX `sh`; the coreutils or busybox
 * utilities it calls, `base64` among them (mkdir, chmod, mv, cat, sleep, tail,
 * base64, tr, wc, sed, cut, grep, rm, nohup); `setsid`, preferred — without
 * it the stop is weaker, see below; a writable `$TMPDIR`, or `/tmp`; `/proc`,
 * optional — where it is missing, a live pid is taken at `kill -0`'s word; and
 * `bash`, for a script.
 *
 * KNOWN LIMITATIONS:
 * - Descendants that leave the process group (their own `setsid`, a double
 *   fork, `docker run -d`) are neither stopped nor noticed — on a cancel, on a
 *   timeout, or when the command exits normally and leaves them running.
 * - Without `setsid`, under dash, a stop reaches the supervisor only.
 * - An unreachable node leaves its tasks `running` until their deadline —
 *   forever, with no time limit — and nothing surfaces "no contact for N
 *   minutes".
 * - The log file has no size cap.
 * - A start that does not report its pid within ~5 s (100 s where `sleep`
 *   takes whole seconds only) is recorded as not started, although the
 *   supervisor may still start.
 * - Exit codes above 128 are not decoded into signals.
 * - A task directory on a node that stays unreachable until the task's row is
 *   dropped (30 days after it ended) is never removed.
 * - Delivery gives up silently 7 days after the task ended.
 * - Exercised live only on a Linux container, through local exec; ssh,
 *   docker-exec, WSL and macOS are untested.
 *
 * THE TASK DIRECTORY, `${TMPDIR:-/tmp}/opencroft-tasks/<taskId>` on the node:
 *
 *   log        the command's stdout and stderr, as it writes them
 *   pid        the supervising shell's pid, which is also its process group
 *   exit       the command's exit status, once it has ended
 *   script.sh  a script task's body
 *
 * `pid` and `exit` are written to a scratch name and renamed into place, so a
 * reader sees a whole value or none. Nothing in the directory carries a secret:
 * injected values reach the command through its environment, which the
 * detached process inherits from the exec that launched it.
 */

import type { Ending } from './store'
import type { StartRunnerTaskInput } from './types'

/** How much of the log a finished task keeps: its last lines, then capped in bytes. */
export const TAIL_MAX_LINES = 200
export const TAIL_MAX_BYTES = 16 * 1024

// Between TERM to the process group and KILL to whatever is left of it.
const STOP_GRACE_STEPS = 10
const STOP_GRACE_STEP_SECONDS = 0.5

/** What the runner needs from the remote tools — the one seam a test replaces. */
export interface RunnerTransport {
  /**
   * The target's terminal context, and the directory a command sent there with
   * `cwd` runs in — both resolved as the remote tools resolve them.
   */
  resolve(target: string, cwd?: string): Promise<{ ctx: Record<string, unknown>; cwd?: string }>
  /** Run a command: stdout on exit 0, a throw on anything else. */
  exec(
    ctx: Record<string, unknown>,
    command: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<string>
  /** Secret names to the env map the command receives. */
  secretsEnv(names: string[] | undefined): Promise<Record<string, string> | undefined>
  /** Write a file on the node byte-for-byte, as remote_write does. */
  writeFile(ctx: Record<string, unknown>, filePath: string, content: string): Promise<void>
}

export interface RunnerTaskRef {
  taskId: string
  dir: string
}

/** What one task looked like to one probe. */
export type ProbeReport =
  | { status: 'running' }
  /** The directory itself is gone: the node was rebuilt, or its temp directory cleared. */
  | { status: 'gone' }
  /** Ended and recorded how: `exitCode` null when the marker held no number. */
  | { status: 'exited'; exitCode: number | null; tail: string }
  /** Not running, and never recorded an ending: killed along with its supervisor. */
  | { status: 'vanished'; tail: string }

/** A start as the contract states it, less what only the service reads. No tool name: the mode says what to run. */
export interface LaunchInput
  extends Pick<StartRunnerTaskInput, 'target' | 'mode' | 'command' | 'args' | 'cwd' | 'secrets'> {
  taskId: string
}

export interface Launched {
  dir: string
  pid: number
  logPath: string
}

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// POSIX single quoting, the rule remote-tools.ts's `shellQuote` applies. Not
// imported from there: that module's import graph comes back round to tools.ts,
// which reads its exports while it loads, so a module that imports it FIRST
// dies on an uninitialised binding — measured, as this runner's own test file
// failing to load. Only remote-transport.ts reaches it, and only by import().
function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Whether `dir` is a task directory this runner made for `taskId`. Checked
 * before anything is removed: the path comes back out of the database, and a
 * row that had been damaged must not be able to aim `rm -rf` anywhere else.
 */
export function isTaskDir(dir: string, taskId: string): boolean {
  return TASK_ID.test(taskId) && dir.startsWith('/') && dir.endsWith(`/opencroft-tasks/${taskId}`)
}

/** Create the task's directory and print its absolute, symlink-free path. */
export function buildPrepareCommand(taskId: string): string {
  if (!TASK_ID.test(taskId)) {
    throw new Error(`Not a task id: ${taskId}`)
  }
  return [
    `d="\${TMPDIR:-/tmp}/opencroft-tasks/${taskId}"`,
    // 700: the log is the command's own output, which nobody else on the node
    // would have seen from a synchronous exec either.
    'mkdir -p "$d" && chmod 700 "$d" && cd "$d" && pwd -P',
  ].join('\n')
}

/**
 * Runs as `sh -c SUPERVISOR opencroft-task <dir> <program…>`: records its own
 * pid, runs the program as its CHILD, then records how the program ended. A
 * child rather than its own body, so nothing the program does — an `exit`, an
 * `exec` — can skip writing the status. One line, so it reads as one in `ps`.
 */
const SUPERVISOR = [
  'd=$1',
  'shift',
  `printf '%s\\n' "$$" > "$d/pid.tmp" && mv -f "$d/pid.tmp" "$d/pid"`,
  '"$@"',
  'rc=$?',
  `printf '%s\\n' "$rc" > "$d/exit.tmp" && mv -f "$d/exit.tmp" "$d/exit"`,
].join('; ')

/**
 * The program the supervisor runs, as shell words for the launch command.
 *
 * A `command` runs under `"$0"` — the shell the exec itself runs in, expanded
 * by the launching shell before anything detaches. That is the shell a
 * synchronous `remote_exec` would have run it under (bash locally, the login
 * shell over ssh, `sh` in a container), so a command does not change meaning
 * by being sent to the background. A `script` runs under bash from the file
 * the launch wrote, with its arguments, as `remote_script` runs one.
 */
export function buildProgram(input: { mode: LaunchInput['mode']; command: string; args?: string[]; dir: string }) {
  if (input.mode === 'script') {
    return ['bash', quote(`${input.dir}/script.sh`), ...(input.args ?? []).map(quote)].join(' ')
  }
  return `"$0" -c ${quote(input.command)}`
}

/**
 * Start the supervisor detached, wait for it to record its pid, and print that.
 *
 * `setsid` makes the supervisor a session and process-group leader, so a stop
 * reaches everything the command started and a closing terminal session sends
 * it nothing. Without `setsid`, `nohup` keeps it alive past the exec, and
 * `set -m` gives it a process group of its own in the shells that honour job
 * control outside a terminal (bash, zsh — not dash, where a stop reaches only
 * the supervisor's own pid).
 *
 * All three standard streams are redirected, and that is load-bearing for ssh:
 * a channel stays open while any process holds its stdout or stderr, so a
 * detached command still attached to either would hold the exec until the cap.
 *
 * The wait is for the pid the supervisor writes itself rather than for `$!`,
 * which names setsid's parent whenever setsid has to fork.
 */
export function buildLaunchCommand(dir: string, program: string): string {
  const detached = `sh -c ${quote(SUPERVISOR)} opencroft-task "$d" ${program} </dev/null >"$d/log" 2>&1 &`
  return [
    `d=${quote(dir)}`,
    'if command -v setsid >/dev/null 2>&1; then',
    `  setsid ${detached}`,
    'else',
    '  set -m 2>/dev/null',
    `  nohup ${detached}`,
    'fi',
    'i=0',
    'while [ ! -s "$d/pid" ] && [ "$i" -lt 100 ]; do',
    '  sleep 0.05 2>/dev/null || sleep 1',
    '  i=$((i + 1))',
    'done',
    'if [ -s "$d/pid" ]; then cat "$d/pid"; exit 0; fi',
    'echo "the task did not start" >&2',
    'tail -c 2000 "$d/log" >&2 2>/dev/null',
    'exit 1',
  ].join('\n')
}

/**
 * The functions the probe and the stop share.
 *
 * `alive` asks three things of the recorded pid, because `kill -0` alone
 * answers yes in two cases that are not the task running: a supervisor that
 * has exited but is a zombie under a parent that never reaps (a container
 * whose pid 1 is not an init), and a pid the kernel has since handed to an
 * unrelated process. Where /proc exists it tells both apart; elsewhere the
 * answer is `kill -0`'s.
 *
 * `report` looks for the exit marker before asking whether the process lives,
 * and once more after: a task that ended between the two looks must read as
 * ended, not as a process that vanished without saying how.
 */
const REPORT_FUNCTIONS = [
  'alive() {',
  '  p=$(cat "$1/pid" 2>/dev/null) || return 1',
  '  [ -n "$p" ] && kill -0 "$p" 2>/dev/null || return 1',
  '  [ -r "/proc/$p/stat" ] || return 0',
  `  [ "$(sed 's/.*) //' "/proc/$p/stat" | cut -c1)" != Z ] || return 1`,
  `  tr '\\000' '\\n' < "/proc/$p/cmdline" | grep -qxF -- "$1"`,
  '}',
  `tail_of() { tail -n ${TAIL_MAX_LINES} "$1/log" 2>/dev/null | tail -c ${TAIL_MAX_BYTES} | base64 | tr -d '\\n'; }`,
  `size_of() { if [ -f "$1/log" ]; then wc -c < "$1/log" | tr -d ' '; else echo 0; fi; }`,
  'report() {',
  '  if [ ! -d "$2" ]; then echo "opencroft-task $1 gone"; return; fi',
  '  if [ ! -f "$2/exit" ] && alive "$2"; then echo "opencroft-task $1 running"; return; fi',
  '  c=$(cat "$2/exit" 2>/dev/null)',
  '  if [ -n "$c" ]; then s=exited; else s=vanished; c=-; fi',
  '  echo "opencroft-task $1 $s $c $(size_of "$2") $(tail_of "$2")"',
  '}',
].join('\n')

/** One exec that reports on every listed task: one line each, see `parseProbe`. */
export function buildProbeCommand(tasks: RunnerTaskRef[]): string {
  return [REPORT_FUNCTIONS, ...tasks.map((task) => `report ${quote(task.taskId)} ${quote(task.dir)}`)].join('\n')
}

/**
 * TERM the task's process group, KILL what is left after the grace, then report
 * on it — so a task that finished on its own just before the stop reads as the
 * outcome it actually had.
 */
export function buildStopCommand(task: RunnerTaskRef): string {
  const wait = (steps: number, seconds: number) =>
    `  i=0; while [ "$i" -lt ${steps} ] && alive "$d"; do sleep ${seconds} 2>/dev/null || sleep 1; i=$((i + 1)); done`
  return [
    REPORT_FUNCTIONS,
    `d=${quote(task.dir)}`,
    'if alive "$d"; then',
    '  p=$(cat "$d/pid")',
    '  kill -s TERM -- "-$p" 2>/dev/null || kill -s TERM -- "$p" 2>/dev/null',
    wait(STOP_GRACE_STEPS, STOP_GRACE_STEP_SECONDS),
    '  kill -s KILL -- "-$p" 2>/dev/null || kill -s KILL -- "$p" 2>/dev/null',
    wait(10, 0.2),
    'fi',
    `report ${quote(task.taskId)} "$d"`,
  ].join('\n')
}

export function buildRemoveCommand(dirs: string[]): string {
  return `rm -rf -- ${dirs.map(quote).join(' ')}`
}

/**
 * The end of a log as it arrived, made readable: decoded, and with a line cut
 * in half by the byte cap dropped rather than shown as if it were whole. When
 * the log is longer than what arrived, the text says so where a reader starts.
 */
export function decodeTail(base64: string, logBytes: number): string {
  const bytes = Buffer.from(base64, 'base64')
  const text = bytes.toString('utf8')
  if (logBytes <= bytes.length) {
    return text
  }
  // Cut at the start. The line bound cuts between lines; only the byte bound
  // can have cut through one.
  const whole = bytes.length >= TAIL_MAX_BYTES ? text.slice(text.indexOf('\n') + 1) : text
  return `… (earlier output cut: the log is ${formatBytes(logBytes)}; these are its last lines)\n${whole}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * Read a probe's output: one `opencroft-task <id> <status> …` line per task.
 * A line that does not parse is skipped rather than guessed at — the task it
 * named simply goes unreported this time and is asked about again next time.
 */
export function parseProbe(output: string): Map<string, ProbeReport> {
  const reports = new Map<string, ProbeReport>()
  for (const line of output.split('\n')) {
    const [marker, taskId, status, code, size, tail = ''] = line.trim().split(' ')
    if (marker !== 'opencroft-task' || !taskId) {
      continue
    }
    const report = toReport(status, code, Number(size), tail)
    if (report) {
      reports.set(taskId, report)
    }
  }
  return reports
}

function toReport(
  status: string | undefined,
  code: string | undefined,
  size: number,
  tail: string,
): ProbeReport | null {
  if (status === 'running' || status === 'gone') {
    return { status }
  }
  const logBytes = Number.isFinite(size) ? size : 0
  if (status === 'vanished') {
    return { status, tail: decodeTail(tail, logBytes) }
  }
  if (status === 'exited') {
    const exitCode = /^\d+$/.test(code ?? '') ? Number(code) : null
    return { status, exitCode, tail: decodeTail(tail, logBytes) }
  }
  return null
}

/** How a runner task ended, from what its node reported. */
export function endingOf(report: Exclude<ProbeReport, { status: 'running' }>): Ending {
  if (report.status === 'gone') {
    return {
      state: 'failed',
      reason: 'its directory is gone from the node (the node was rebuilt, or its temp directory cleared)',
    }
  }
  const outputTail = report.tail || undefined
  if (report.status === 'vanished') {
    return { state: 'failed', reason: 'process vanished', outputTail }
  }
  if (report.exitCode === null) {
    return { state: 'failed', reason: 'its exit status could not be read', outputTail }
  }
  return { state: report.exitCode === 0 ? 'completed' : 'failed', exitCode: report.exitCode, outputTail }
}

function parseDir(output: string, taskId: string): string {
  const dir = output.trim()
  if (!isTaskDir(dir, taskId)) {
    throw new Error(`The node reported an unexpected task directory: ${JSON.stringify(dir)}`)
  }
  return dir
}

function parsePid(output: string): number {
  const pid = Number(output.trim())
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`The node reported an unexpected pid: ${JSON.stringify(output.trim())}`)
  }
  return pid
}

// Every exec but the launch runs from `/`: it names absolute paths only, and
// the target's own working directory may be gone by then — a worktree removed
// once its build finished must not leave that build unobservable.
const ROOT = { cwd: '/' }

export class BackgroundTaskRunner {
  constructor(private readonly transport: RunnerTransport) {}

  /**
   * Make the task's directory, write the script when there is one, and start
   * the command detached with its cwd and secrets. Returns once the node has a
   * pid for it — so a command that cannot even start fails here, to its caller,
   * rather than as a task that dies on the first probe.
   */
  async launch(input: LaunchInput): Promise<Launched> {
    const { ctx, cwd } = await this.transport.resolve(input.target, input.cwd)
    const env = await this.transport.secretsEnv(input.secrets)
    const dir = parseDir(await this.transport.exec(ctx, buildPrepareCommand(input.taskId), ROOT), input.taskId)
    if (input.mode === 'script') {
      await this.transport.writeFile(ctx, `${dir}/script.sh`, input.command)
    }
    const program = buildProgram({ mode: input.mode, command: input.command, args: input.args, dir })
    const pid = parsePid(await this.transport.exec(ctx, buildLaunchCommand(dir, program), { cwd, env }))
    return { dir, pid, logPath: `${dir}/log` }
  }

  async probe(target: string, tasks: RunnerTaskRef[]): Promise<Map<string, ProbeReport>> {
    const { ctx } = await this.transport.resolve(target)
    return parseProbe(await this.transport.exec(ctx, buildProbeCommand(tasks), ROOT))
  }

  /** The task's report after the stop, or null when the node gave none. */
  async stop(target: string, task: RunnerTaskRef): Promise<ProbeReport | null> {
    const { ctx } = await this.transport.resolve(target)
    return parseProbe(await this.transport.exec(ctx, buildStopCommand(task), ROOT)).get(task.taskId) ?? null
  }

  async remove(target: string, dirs: string[]): Promise<void> {
    const { ctx } = await this.transport.resolve(target)
    await this.transport.exec(ctx, buildRemoveCommand(dirs), ROOT)
  }
}
