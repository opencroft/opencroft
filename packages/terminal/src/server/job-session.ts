import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { sessionManager } from './manager'
import type { SessionHandle } from './session-manager'

/**
 * Server-started jobs, watchable from the browser through the ordinary terminal session.
 *
 * ─── THIS ENTRY POINT IS FOR SERVER CODE AND MUST STAY THAT WAY ───
 *
 * `startJobSession` runs a command chosen by its caller. If any client message could reach it —
 * a new `case` in socket.ts's switch, a route handler forwarding a request body — that would be
 * arbitrary command execution by anyone holding a session cookie. The protection is not that no
 * such case exists today; it is that this module is never imported by the message path, and
 * `job-session-isolation.test.ts` fails the build if that changes. Read that test before adding
 * a socket message that starts anything.
 *
 * The session key is a random token rather than something a caller supplies, and it is the only
 * way to reach the job: a key is the whole authorisation to attach to a session, so a guessable
 * one would put the job's output — and a write channel into it — within reach of anyone who
 * could guess it.
 *
 * ─── AND IT DELIBERATELY DOES NOT USE A PTY ───
 *
 * A pty echoes whatever is written to its stdin straight back to the reader. A job whose input
 * is a document — a compose file on `-f -`, a script on stdin — would therefore print that
 * document to everyone watching, and those documents are exactly where resolved secret values
 * live. Piped stdio has no echo, so what a watcher receives is the process's own output and
 * nothing else.
 */

export interface JobSessionOptions {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  /**
   * Written to the job's stdin once, which is then closed. Safe for a document carrying resolved
   * secret values: with piped stdio it reaches the process and is never echoed back to a watcher.
   */
  stdin?: string
}

export interface JobSession {
  /** Hand this to the client; it is what `<Terminal sessionKey=…/>` attaches to. Unguessable. */
  sessionKey: string
  sessionId: string
}

/**
 * A `SessionHandle` over a piped child process — the third adapter alongside socket.ts's pty and
 * ssh ones, so the manager treats a job exactly like any other session.
 *
 * Two differences from a pty are handled here rather than being left to surprise a reader:
 * line endings, because a pipe emits bare `\n` and a terminal needs `\r\n` or every line starts
 * where the last one ended; and `resize`, which a pipe has no concept of, so it does nothing
 * rather than pretending.
 */
export function pipedProcessHandle(child: ChildProcess): SessionHandle {
  let alive = true
  let exited = false
  const exitFns: (() => void)[] = []
  const dataFns: ((data: string) => void)[] = []
  // Anything the job says before a watcher is listening. A spawn failure arrives on the tick
  // after `spawn` returns, which can be before the manager has registered its callbacks — and
  // the reason a job never started is the one message that must not be the one that is dropped.
  let pending = ''

  const emit = (text: string) => {
    const forTerminal = text.replace(/\r?\n/g, '\r\n')
    if (dataFns.length === 0) {
      pending += forTerminal
      return
    }
    for (const fn of dataFns) {
      fn(forTerminal)
    }
  }

  const finish = () => {
    if (exited) {
      return
    }
    exited = true
    alive = false
    for (const fn of exitFns) {
      fn()
    }
  }

  child.on('close', finish)

  // A job that cannot start ends like a job that finished, and says why. Without this the
  // `'error'` event has no listener, and Node raises an unhandled one rather than swallowing it:
  // a command that is not on PATH, or a cwd that does not exist, takes the process down. The
  // caller cannot fix that from outside — it is handed a key, not the child — so it belongs here.
  child.on('error', (err: Error) => {
    emit(`\n${err.message}\n`)
    finish()
  })

  // A child that dies before it reads its input makes the write fail, and an unhandled stream
  // error is raised the same way. That is a race rather than a fault of the writer: the job is
  // already ending, and its own `'close'` says so.
  child.stdin?.on('error', () => {})

  return {
    onData(fn) {
      // setEncoding decodes across chunk boundaries, so a multi-byte character split by the pipe
      // arrives whole instead of as two replacement characters.
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      const forward = (data: string) => emit(data)
      child.stdout?.on('data', forward)
      child.stderr?.on('data', forward)
      dataFns.push(fn)
      if (pending) {
        fn(pending)
        pending = ''
      }
    },
    onExit(fn) {
      // Registering after the job has already ended still fires: a spawn failure can beat the
      // manager to it, and a listener that arrives late must not wait forever for an event that
      // has been and gone.
      if (exited) {
        fn()
        return
      }
      exitFns.push(fn)
    },
    write() {
      // A job takes its input once, at creation. Ignoring writes here is what stops an attached
      // watcher from typing into somebody's build.
    },
    resize() {
      /* a pipe has no window size */
    },
    kill() {
      child.kill()
    },
    isAlive() {
      return alive
    },
  }
}

/**
 * Start a command as a watchable session and return the key a client can attach to.
 *
 * Server code only — see the module comment above.
 */
export function startJobSession(opts: JobSessionOptions): JobSession {
  const slot = sessionManager.prepareJob()
  if (!slot.ok) {
    throw new Error(slot.message)
  }

  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // The handle is built before anything is written, because it is what installs the `'error'`
  // listeners. Writing first would leave a window where a child that failed to spawn raises an
  // unhandled stream error instead of becoming a job that ended and said why.
  const handle = pipedProcessHandle(child)

  if (opts.stdin !== undefined) {
    child.stdin?.end(opts.stdin)
  } else {
    child.stdin?.end()
  }

  // 32 hex characters. The key is the whole authorisation to attach, so it is generated here and
  // never derived from anything a caller could also compute (a node id, a service name).
  const sessionKey = `job:${randomBytes(16).toString('hex')}`
  const session = sessionManager.create(null, handle, { sessionKey, kind: 'job' })
  return { sessionKey, sessionId: session.id }
}
