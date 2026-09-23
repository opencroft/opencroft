// The background task runner, in two halves.
//
// The shell text first, where what matters is what is IN it: every stream
// redirected so an ssh channel can close, the setsid and nohup branches, and no
// secret value in anything that is written down — the command line, the
// script, the task directory.
//
// Then real runs on a local terminal context — the same backend call the
// remote tools end in — because the properties that matter are what a shell
// actually does with that text: the launch returns before the command ends, the
// command outlives the exec, the exit status and the tail come back, and a stop
// reaches the whole process group. A double would only agree with this file's
// own idea of a shell.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import type { TerminalContext } from '@opencroft/terminal'
import { terminalExecResult } from '@opencroft/terminal/server'

import {
  BackgroundTaskRunner,
  buildLaunchCommand,
  buildPrepareCommand,
  buildProgram,
  buildStopCommand,
  decodeTail,
  isTaskDir,
  type ProbeReport,
  parseProbe,
  type RunnerTaskRef,
  type RunnerTransport,
  TAIL_MAX_BYTES,
} from './background-task-runner'

const SECRET_NAME = 'BG_TASK_TEST_SECRET'
const SECRET_VALUE = `not-on-the-node-${randomUUID()}`
const TARGET = 'local/terminal'

// ── the text ─────────────────────────────────────────────────────────────

test('the launch redirects all three streams of the detached process, in both branches', () => {
  const program = buildProgram({ mode: 'command', command: 'make', dir: '/tmp/x' })
  const command = buildLaunchCommand('/tmp/opencroft-tasks/x', program)
  const detached = command.split('\n').filter((line) => line.includes('opencroft-task "$d"'))
  assert.equal(detached.length, 2)
  for (const line of detached) {
    assert.match(line, /<\/dev\/null >"\$d\/log" 2>&1 &$/)
  }
  assert.ok(detached[0].trimStart().startsWith('setsid sh -c '))
  assert.ok(detached[1].trimStart().startsWith('nohup sh -c '))
  assert.match(command, /if command -v setsid >\/dev\/null 2>&1; then/)
})

test('a command runs under the exec’s own shell, a script under bash with its arguments', () => {
  assert.equal(buildProgram({ mode: 'command', command: "echo 'a b'", dir: '/d' }), `"$0" -c 'echo '\\''a b'\\'''`)
  assert.equal(
    buildProgram({ mode: 'script', command: 'ignored', args: ['one', 'two words'], dir: '/d' }),
    `bash '/d/script.sh' 'one' 'two words'`,
  )
})

test('the prepare command refuses anything but a task id, and the directory check accepts only its own', () => {
  const id = randomUUID()
  assert.match(buildPrepareCommand(id), new RegExp(`opencroft-tasks/${id}"`))
  assert.throws(() => buildPrepareCommand('../../etc'))
  assert.equal(isTaskDir(`/tmp/opencroft-tasks/${id}`, id), true)
  assert.equal(isTaskDir('/', id), false)
  assert.equal(isTaskDir(`relative/opencroft-tasks/${id}`, id), false)
  assert.equal(isTaskDir(`/tmp/opencroft-tasks/${id}`, randomUUID()), false)
})

test('no secret value appears in any text the runner sends or writes, only its name', async () => {
  const sent: { command: string; env?: Record<string, string> }[] = []
  const written: string[] = []
  const id = randomUUID()
  const script = `echo "$${SECRET_NAME}" | sha256sum\n`
  const recording: RunnerTransport = {
    resolve: async (_target, cwd) => ({ ctx: { type: 'local' }, cwd }),
    secretsEnv: async (names) => (names ? Object.fromEntries(names.map((name) => [name, SECRET_VALUE])) : undefined),
    writeFile: async (_ctx, filePath, content) => {
      written.push(filePath, content)
    },
    exec: async (_ctx, command, opts) => {
      sent.push({ command, env: opts?.env })
      if (command.includes('mkdir -p')) {
        return `/tmp/opencroft-tasks/${id}\n`
      }
      return command.includes('opencroft-task "$d"') ? '4242\n' : ''
    },
  }
  await new BackgroundTaskRunner(recording).launch({
    taskId: id,
    target: TARGET,
    mode: 'script',
    command: script,
    secrets: [SECRET_NAME],
  })
  assert.deepEqual(written, [`/tmp/opencroft-tasks/${id}/script.sh`, script])
  for (const text of [...sent.map(({ command }) => command), ...written]) {
    assert.equal(text.includes(SECRET_VALUE), false, `secret value in: ${text.slice(0, 80)}`)
  }
  // It travels only as the env of the one exec that starts the process.
  const withEnv = sent.filter(({ env }) => env !== undefined)
  assert.equal(withEnv.length, 1)
  assert.deepEqual(withEnv[0].env, { [SECRET_NAME]: SECRET_VALUE })
  assert.ok(withEnv[0].command.includes('opencroft-task "$d"'))
})

test('a probe line per task, and a line that does not parse is left out rather than guessed at', () => {
  const tail = Buffer.from('built\nexit now\n').toString('base64')
  const reports = parseProbe(
    [
      'opencroft-task a running',
      `opencroft-task b exited 3 15 ${tail}`,
      'opencroft-task c vanished - 0 ',
      'opencroft-task d gone',
      'opencroft-task e exited garbage 0 ',
      'noise from a login script',
      'opencroft-task f sideways',
    ].join('\n'),
  )
  assert.deepEqual(Object.fromEntries(reports), {
    a: { status: 'running' },
    b: { status: 'exited', exitCode: 3, tail: 'built\nexit now\n' },
    c: { status: 'vanished', tail: '' },
    d: { status: 'gone' },
    e: { status: 'exited', exitCode: null, tail: '' },
  } satisfies Record<string, ProbeReport>)
})

test('a tail cut at the byte bound drops its broken first line and says the log is longer', () => {
  const full = `${'x'.repeat(100)}\n${'y'.repeat(TAIL_MAX_BYTES - 101)}`
  const text = decodeTail(Buffer.from(full).toString('base64'), 5 * 1024 * 1024)
  assert.ok(text.startsWith('… (earlier output cut: the log is 5.0 MiB; these are its last lines)\n'))
  assert.ok(text.endsWith('y'.repeat(50)))
  assert.equal(text.includes('x'), false)
  // A whole log comes back as it is.
  assert.equal(decodeTail(Buffer.from('all of it\n').toString('base64'), 10), 'all of it\n')
})

test('the stop signals the process group before the pid, TERM before KILL', () => {
  const command = buildStopCommand({ taskId: 't', dir: '/d/opencroft-tasks/t' })
  const term = command.indexOf('kill -s TERM -- "-$p"')
  const kill = command.indexOf('kill -s KILL -- "-$p"')
  assert.ok(term > 0 && kill > term)
  assert.match(command, /kill -s TERM -- "-\$p" 2>\/dev\/null \|\| kill -s TERM -- "\$p"/)
  assert.ok(command.trimEnd().endsWith(`report 't' "$d"`))
})

// ── real runs on a local context ─────────────────────────────────────────

// Its own TMPDIR, so the directories counted and removed below are exactly the
// ones these runs made. Resolved, because the node reports `pwd -P`.
let scratch = ''
let previousTmpdir: string | undefined

before(() => {
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'bg-task-task-runner-')))
  previousTmpdir = process.env.TMPDIR
  process.env.TMPDIR = scratch
})

after(() => {
  if (previousTmpdir === undefined) {
    delete process.env.TMPDIR
  } else {
    process.env.TMPDIR = previousTmpdir
  }
  rmSync(scratch, { recursive: true, force: true })
})

/** A local terminal context, reached the way the core extension's `terminal.exec` reaches it. */
function localTransport(overrides?: Record<string, string>): RunnerTransport {
  return {
    resolve: async (_target, cwd) => ({ ctx: { type: 'local' }, cwd }),
    secretsEnv: async (names) => (names ? Object.fromEntries(names.map((name) => [name, SECRET_VALUE])) : undefined),
    // The node is this machine.
    writeFile: async (_ctx, filePath, content) => writeFileSync(filePath, content),
    exec: async (ctx, command, opts) => {
      const env = overrides ? { ...opts?.env, ...overrides } : opts?.env
      const result = await terminalExecResult(ctx as TerminalContext, command, { ...opts, env })
      if (result.exitCode !== 0) {
        throw new Error(`Command exited with code ${result.exitCode}: ${result.stderr}`)
      }
      return result.stdout
    },
  }
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function probeOne(runner: BackgroundTaskRunner, task: RunnerTaskRef): Promise<ProbeReport | undefined> {
  return runner.probe(TARGET, [task]).then((reports) => reports.get(task.taskId))
}

function finished(runner: BackgroundTaskRunner, task: RunnerTaskRef): Promise<ProbeReport | undefined> {
  return until(
    () => probeOne(runner, task),
    (report) => report?.status !== 'running',
  )
}

/** Gone, or a zombie its reaper has not collected yet — either way no longer running. */
function ended(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return true
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/.*\) /, '').startsWith('Z')
  } catch {
    return true
  }
}

test('a detached command outlives the launch, and its exit status and output come back', async () => {
  const runner = new BackgroundTaskRunner(localTransport())
  const taskId = randomUUID()
  const started = Date.now()
  const launched = await runner.launch({
    taskId,
    target: TARGET,
    mode: 'command',
    command: `sleep 2; echo hi; printf '%s' "$${SECRET_NAME}" | sha256sum; exit 3`,
    secrets: [SECRET_NAME],
  })
  // The launch came back while the command was still sleeping.
  assert.ok(Date.now() - started < 1500, `launch took ${Date.now() - started}ms`)
  assert.equal(launched.dir, path.join(scratch, 'opencroft-tasks', taskId))
  assert.equal(launched.logPath, `${launched.dir}/log`)
  const task = { taskId, dir: launched.dir }
  assert.deepEqual(await probeOne(runner, task), { status: 'running' })

  const digest = createHash('sha256').update(SECRET_VALUE).digest('hex')
  assert.deepEqual(await finished(runner, task), { status: 'exited', exitCode: 3, tail: `hi\n${digest}  -\n` })
  assert.ok(Date.now() - started >= 2000)

  // The value reached the process through its environment and nowhere else:
  // not one file the task left behind holds it.
  const files = readdirSync(launched.dir).sort()
  assert.deepEqual(files, ['exit', 'log', 'pid'])
  for (const file of files) {
    assert.equal(readFileSync(path.join(launched.dir, file), 'utf8').includes(SECRET_VALUE), false, file)
  }
})

test('a script runs from the caller’s cwd with its arguments, and its directory holds no secret', async () => {
  const runner = new BackgroundTaskRunner(localTransport())
  const taskId = randomUUID()
  const cwd = mkdtempSync(path.join(scratch, 'cwd-'))
  const launched = await runner.launch({
    taskId,
    target: TARGET,
    mode: 'script',
    command: `echo "cwd=$(pwd)"\necho "args=$1|$2"\n[ -n "$${SECRET_NAME}" ] && echo secret-present\n`,
    args: ['one', 'two words'],
    cwd,
    secrets: [SECRET_NAME],
  })
  assert.deepEqual(await finished(runner, { taskId, dir: launched.dir }), {
    status: 'exited',
    exitCode: 0,
    tail: `cwd=${cwd}\nargs=one|two words\nsecret-present\n`,
  })
  const script = readFileSync(path.join(launched.dir, 'script.sh'), 'utf8')
  assert.ok(script.includes(`$${SECRET_NAME}`))
  assert.equal(script.includes(SECRET_VALUE), false)
})

test('a stop reaches the whole process group, and the task reads as vanished rather than exited', async () => {
  const runner = new BackgroundTaskRunner(localTransport())
  const taskId = randomUUID()
  const childPidFile = path.join(scratch, `${taskId}.child`)
  const launched = await runner.launch({
    taskId,
    target: TARGET,
    mode: 'command',
    // A grandchild of the supervisor, which a signal to one pid would miss.
    command: `sleep 300 & echo $! > '${childPidFile}'; echo started; wait`,
  })
  await until(
    async () => existsSync(childPidFile) && readFileSync(childPidFile, 'utf8').trim() !== '',
    (ready) => ready,
  )
  const child = Number(readFileSync(childPidFile, 'utf8'))
  assert.equal(ended(child), false)

  const report = await runner.stop(TARGET, { taskId, dir: launched.dir })
  assert.deepEqual(report, { status: 'vanished', tail: 'started\n' })
  assert.equal(
    await until(
      async () => ended(launched.pid) && ended(child),
      (done) => done,
    ),
    true,
  )
})

test('a task killed along with its supervisor reads as vanished', async () => {
  const runner = new BackgroundTaskRunner(localTransport())
  const taskId = randomUUID()
  const launched = await runner.launch({ taskId, target: TARGET, mode: 'command', command: 'sleep 300' })
  process.kill(-launched.pid, 'SIGKILL')
  assert.deepEqual(await finished(runner, { taskId, dir: launched.dir }), { status: 'vanished', tail: '' })
})

test('a pid now held by another process is not the task, and a missing directory reads as gone', async () => {
  const runner = new BackgroundTaskRunner(localTransport())
  const task = { taskId: randomUUID(), dir: '' }
  task.dir = path.join(scratch, 'opencroft-tasks', task.taskId)
  assert.deepEqual(await probeOne(runner, task), { status: 'gone' })
  // This test's own process is alive and answers kill -0 — and is not the
  // task's supervisor.
  mkdirSync(task.dir, { recursive: true })
  writeFileSync(path.join(task.dir, 'pid'), `${process.pid}\n`)
  assert.deepEqual(await probeOne(runner, task), { status: 'vanished', tail: '' })
})

test('without setsid the nohup branch still detaches, and the command still reports', async () => {
  // A PATH holding everything the launch and the command use, except setsid.
  const bin = mkdtempSync(path.join(scratch, 'bin-'))
  for (const tool of ['sh', 'bash', 'nohup', 'cat', 'mv', 'sleep', 'tail', 'mkdir', 'chmod']) {
    const found = ['/usr/bin', '/bin'].map((dir) => path.join(dir, tool)).find((candidate) => existsSync(candidate))
    assert.ok(found, tool)
    symlinkSync(found, path.join(bin, tool))
  }
  const taskId = randomUUID()
  const launched = await new BackgroundTaskRunner(localTransport({ PATH: bin })).launch({
    taskId,
    target: TARGET,
    mode: 'command',
    command: 'command -v setsid || echo no-setsid; sleep 1; exit 7',
  })
  const runner = new BackgroundTaskRunner(localTransport())
  const task = { taskId, dir: launched.dir }
  assert.deepEqual(await probeOne(runner, task), { status: 'running' })
  assert.deepEqual(await finished(runner, task), { status: 'exited', exitCode: 7, tail: 'no-setsid\n' })
})

test('one probe exec covers several tasks, and removal takes their directories', async () => {
  let execs = 0
  const base = localTransport()
  const counting: RunnerTransport = {
    ...base,
    exec: (ctx, command, opts) => {
      execs += 1
      return base.exec(ctx, command, opts)
    },
  }
  const runner = new BackgroundTaskRunner(counting)
  const tasks = await Promise.all(
    [0, 1, 2].map(async (code) => {
      const taskId = randomUUID()
      const launched = await runner.launch({ taskId, target: TARGET, mode: 'command', command: `exit ${code}` })
      return { taskId, dir: launched.dir }
    }),
  )
  await until(
    () => runner.probe(TARGET, tasks),
    (reports) => [...reports.values()].every((report) => report.status !== 'running'),
  )
  execs = 0
  const reports = await runner.probe(TARGET, tasks)
  assert.equal(execs, 1)
  assert.deepEqual(
    tasks.map((task) => reports.get(task.taskId)),
    [0, 1, 2].map((code) => ({ status: 'exited', exitCode: code, tail: '' })),
  )
  await runner.remove(
    TARGET,
    tasks.map((task) => task.dir),
  )
  assert.deepEqual(
    tasks.map((task) => existsSync(task.dir)),
    [false, false, false],
  )
})
