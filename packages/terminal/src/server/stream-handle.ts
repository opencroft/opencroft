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

/**
 * A stateful transform over a stream's output, for a caller that must change what a watcher sees
 * — redacting it, for instance — before any of it is kept or sent.
 *
 * `push` receives the output as the transport delivers it, cut wherever the transport cut it, and
 * returns what may be shown now; it may hold text back for a later call. `flush` returns whatever
 * it still holds, and is called once, when the stream ends, before the end is reported.
 *
 * If either throws, the stream fails closed: nothing more of its output is shown, a fixed notice
 * says so, and the command is stopped. A filter that cannot run must not become a filter that lets
 * everything through.
 */
export interface OutputFilter {
  push(text: string): string
  flush(): string
}

/** What a watcher sees in place of the rest of the output when the filter throws. */
export const FILTER_FAILED_NOTICE = '\noutput filter failed; job stopped\n'

export function makeStreamHandle(kill: () => void, filter?: OutputFilter): StreamHandle {
  let alive = true
  let exited = false
  let filterFailed = false
  const exitFns: (() => void)[] = []
  const dataFns: ((data: string) => void)[] = []
  let pending = ''

  // After the filter: line endings for a terminal, and held until the first watcher subscribes.
  const deliver = (text: string) => {
    const forTerminal = text.replace(/\r?\n/g, '\r\n')
    if (dataFns.length === 0) {
      pending += forTerminal
      return
    }
    for (const fn of dataFns) {
      fn(forTerminal)
    }
  }

  const failClosed = () => {
    filterFailed = true
    deliver(FILTER_FAILED_NOTICE)
    try {
      kill()
    } catch {
      /* the stream is being ended either way */
    }
    finish()
  }

  const runFilter = (step: () => string): string => {
    try {
      return step()
    } catch {
      failClosed()
      return ''
    }
  }

  // Output after the end is dropped: a filter has been flushed by then, and text it never saw
  // cannot be shown unfiltered.
  const emit = (text: string) => {
    if (exited || filterFailed) {
      return
    }
    const shown = filter ? runFilter(() => filter.push(text)) : text
    if (shown) {
      deliver(shown)
    }
  }

  const finish = () => {
    if (exited) {
      return
    }
    if (filter && !filterFailed) {
      const tail = runFilter(() => filter.flush())
      if (tail) {
        deliver(tail)
      }
      // A flush that threw has already failed closed, and that finished the stream.
      if (exited) {
        return
      }
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
export function pipedProcessHandle(child: ChildProcess, filter?: OutputFilter): StreamHandle {
  const handle = makeStreamHandle(() => child.kill(), filter)

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
