// A streamed ssh job against a real OpenSSH server. What is asserted lives on the far side of the
// connection — whether the remote command is still running, whether its input arrived and ended —
// so an in-process ssh2 server would only assert what that library does, and it drops the very
// request the stop depends on. The server here is an unprivileged `sshd` on 127.0.0.1, started per
// file, and the "remote" commands are processes on this machine, which is what makes them
// observable.
import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, test } from 'node:test'

import type { TerminalContext } from '../types'
import { getBackend } from './backend'
import { closeAllSshPools } from './ssh'
import type { StreamHandle } from './stream-handle'

function findSshd(): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/usr/sbin', '/usr/local/sbin']
  for (const dir of dirs) {
    const candidate = join(dir, 'sshd')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* not here */
    }
  }
  return undefined
}

function hasSshKeygen(): boolean {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'pipe' })
    return true
  } catch (e) {
    // `-?` is not a real flag: usage on stderr means the binary is there.
    return /usage/i.test(String((e as { stderr?: Buffer }).stderr ?? ''))
  }
}

const sshdPath = findSshd()
const loginShell = userInfo().shell ?? ''

function skipReason(): string | false {
  if (!sshdPath) {
    return 'sshd not installed'
  }
  if (!hasSshKeygen()) {
    return 'ssh-keygen not installed'
  }
  if (!loginShell || /(nologin|false)$/.test(loginShell)) {
    return `this user's login shell (${loginShell || 'none'}) cannot run an ssh command`
  }
  try {
    accessSync('/proc/self/stat')
  } catch {
    return 'no /proc to tell whether a process is still running'
  }
  return false
}

const skip = skipReason()

let dir = ''
let sshd: ChildProcess | undefined
let ctx: TerminalContext

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

/** Resolves once the server sends its version banner, which it does only once it is listening. */
function bannerFrom(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('data', (data) => {
      socket.destroy()
      resolve(data.toString().startsWith('SSH-'))
    })
    socket.once('error', () => resolve(false))
  })
}

async function until(condition: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return condition()
}

/** A zombie has stopped running; it only waits for its parent to collect it. */
function isRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'
  } catch {
    return false
  }
}

before(async () => {
  if (skip) {
    return
  }
  dir = mkdtempSync(join(tmpdir(), 'ssh-stream-test-'))
  for (const key of ['host', 'client']) {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, key)])
  }
  writeFileSync(join(dir, 'authorized_keys'), readFileSync(join(dir, 'client.pub')))
  const port = await freePort()
  writeFileSync(
    join(dir, 'sshd_config'),
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${join(dir, 'host')}`,
      `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
      `PidFile ${join(dir, 'sshd.pid')}`,
      // Unprivileged: no PAM, and no ownership checks on a temp dir.
      'UsePAM no',
      'StrictModes no',
      'PasswordAuthentication no',
      '',
    ].join('\n'),
  )
  // sshd re-executes itself, so it needs the absolute path; `-D -e` keeps it in the foreground,
  // owned by this file.
  sshd = spawn(sshdPath as string, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: 'ignore' })
  assert.ok(await until(() => bannerFrom(port), 10_000), 'the test sshd started')
  ctx = { type: 'ssh', host: '127.0.0.1', port, username: userInfo().username, keyPath: join(dir, 'client') }
})

after(() => {
  closeAllSshPools()
  sshd?.kill()
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function collect(handle: StreamHandle): { text: () => string; ended: (ms: number) => Promise<boolean> } {
  let text = ''
  let done = false
  handle.onData((data) => {
    text += data
  })
  handle.onExit(() => {
    done = true
  })
  return { text: () => text, ended: (ms) => until(() => done, ms) }
}

test('stopping an ssh job ends the remote command, not only its channel', { skip }, async () => {
  // The work is a child of the remote shell, as it is for any command the shell does not exec.
  const handle = await getBackend(ctx).stream(ctx, ['sh', '-c', 'sleep 600 & echo "pid $!"; wait'])
  const watched = collect(handle)
  assert.ok(await until(() => /pid \d+/.test(watched.text()), 10_000), 'the job reported its work')
  const pid = Number(/pid (\d+)/.exec(watched.text())?.[1])
  try {
    assert.equal(isRunning(pid), true, 'the work is running before the stop')

    handle.kill()

    assert.ok(await until(() => !isRunning(pid), 10_000), 'the remote command was stopped with the job')
    assert.ok(await watched.ended(10_000), 'and the session ended')
  } finally {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone, which is the passing case */
    }
  }
})

test('an ssh job still gets its whole input, then end of input', { skip }, async () => {
  // `cat` ends only at end of input, so a job that ends at all was given one.
  const handle = await getBackend(ctx).stream(ctx, ['cat'], { stdin: 'first line\nsecond line\n' })
  const watched = collect(handle)
  assert.ok(await watched.ended(10_000), 'the command saw end of input and finished')
  assert.equal(watched.text(), 'first line\r\nsecond line\r\n')
})

test('an ssh job still gets its env, which travels on the same input', { skip }, async () => {
  const handle = await getBackend(ctx).stream(ctx, ['sh', '-c', 'printf "%s\\n" "$GREETING"; cat'], {
    env: { GREETING: 'hello there' },
  })
  const watched = collect(handle)
  assert.ok(await watched.ended(10_000), 'the command finished')
  assert.equal(watched.text(), 'hello there\r\n', 'the env arrived, and nothing of it was left for the command to read')
})
