import type { ChildProcess } from 'node:child_process'

import type { SessionHandle } from './session-manager'

/**
 * The part of a watchable session that is the same whatever carries it.
 *
 * A pty needs none of this — it buffers, echoes and reports a window size of its own. Everything
 * else does: a local piped child, an ssh exec channel. Three behaviours live here so that each
 * transport does not get its own almost-right version:
 *
 *  - **Output that arrives before anyone is watching is kept.** A job is created detached, and the
 *    reason a job never started arrives on the tick after it is spawned — before the manager has
 *    registered a data callback. That message is precisely the one that must not be dropped.
 *  - **Bare `\n` becomes `\r\n`.** A pipe emits the first; a terminal needs the second, or every
 *    line starts where the last one ended.
 *  - **`exit` fires exactly once, and also for a listener that arrives late.** A failure can beat
 *    the manager to the handle, and a listener registering afterwards must not wait forever for an
 *    event that has already happened.
 *
 * `write` is deliberately inert. A job takes its input once, at creation; ignoring writes is what
 * stops an attached watcher from typing into somebody's build.
 */
export interface StreamHandle extends SessionHandle {
  /** Feed output in, from whatever the transport calls its stdout and stderr. */
  emit(text: string): void
  /** Mark the stream ended. Safe to call more than once; only the first call is delivered. */
  finish(): void
}

export function makeStreamHandle(kill: () => void): StreamHandle {
  let alive = true
  let exited = false
  const exitFns: (() => void)[] = []
  const dataFns: ((data: string) => void)[] = []
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

  return {
    emit,
    finish,
    onData(fn) {
      dataFns.push(fn)
      if (pending) {
        fn(pending)
        pending = ''
      }
    },
    onExit(fn) {
      if (exited) {
        fn()
        return
      }
      exitFns.push(fn)
    },
    write() {
      /* a job takes its input once, at creation — see the interface comment */
    },
    resize() {
      /* a pipe has no window size */
    },
    kill,
    isAlive() {
      return alive
    },
  }
}

/**
 * A `SessionHandle` over a piped child process, for a command running in this container.
 *
 * The two child-process specifics that are not shared with other transports are here: decoding
 * across chunk boundaries, so a multi-byte character split by the pipe arrives whole rather than
 * as two replacement characters; and the `'error'` listener, without which a command that is not
 * on PATH — or a cwd that does not exist — raises an unhandled exception and takes the process
 * down. The caller cannot install that itself: it is handed a key, not the child.
 */
export function pipedProcessHandle(child: ChildProcess): StreamHandle {
  const handle = makeStreamHandle(() => child.kill())

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (data: string) => handle.emit(data))
  child.stderr?.on('data', (data: string) => handle.emit(data))

  child.on('close', handle.finish)

  // A job that cannot start ends like a job that finished, and says why.
  child.on('error', (err: Error) => {
    handle.emit(`\n${err.message}\n`)
    handle.finish()
  })

  // A child that dies before it reads its input makes the write fail, and an unhandled stream
  // error is raised the same way. That is a race rather than a fault of the writer: the job is
  // already ending, and its own `'close'` says so.
  child.stdin?.on('error', () => {})

  return handle
}
