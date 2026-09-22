// Action handlers nobody awaits: the other way a background task runs. The
// work is a promise in this process, so it has none of a node task's
// durability — it lives and dies with the process, and after a restart there
// is nothing left of it to watch (the service fails such a task rather than
// pretending it might still end).
//
// Each handler gets an AbortSignal, and aborting it is how a cancel and a
// timeout both reach the work — and all they can do: a handler that ignores its
// signal keeps running, which is why stopping one is only ever a request.

import { TAIL_MAX_BYTES } from './node-runner'

export type Settled = { ok: true; value: unknown } | { ok: false; error: unknown }

export class InProcessRunner {
  /**
   * `controllers` is handed in rather than owned, so it can outlive a reload of
   * this module: the handles belong to the process, not to one evaluation of
   * the code that made them.
   */
  constructor(private readonly controllers: Map<string, AbortController>) {}

  /**
   * Claim the task for this process BEFORE its row exists, so nothing that
   * looks for running tasks this process does not hold can mistake it for a
   * previous process's leftover in the moment between the two.
   */
  register(taskId: string): void {
    this.controllers.set(taskId, new AbortController())
  }

  forget(taskId: string): void {
    this.controllers.delete(taskId)
  }

  has(taskId: string): boolean {
    return this.controllers.has(taskId)
  }

  /** Start the work, not awaited. `onSettled` hears how it ended, exactly once. */
  run(taskId: string, work: (signal: AbortSignal) => Promise<unknown>, onSettled: (settled: Settled) => void): void {
    const controller = this.controllers.get(taskId)
    if (!controller) {
      throw new Error(`Background task ${taskId} was not registered`)
    }
    // Through a `then`, so a handler that throws before returning a promise
    // settles the same way as one that rejects.
    void Promise.resolve()
      .then(() => work(controller.signal))
      .then(
        (value): Settled => ({ ok: true, value }),
        (error: unknown): Settled => ({ ok: false, error }),
      )
      .then((settled) => {
        this.controllers.delete(taskId)
        onSettled(settled)
      })
  }

  /** Signal the work to stop. False when this process is not running it. */
  abort(taskId: string, reason: string): boolean {
    const controller = this.controllers.get(taskId)
    if (!controller) {
      return false
    }
    controller.abort(new Error(reason))
    return true
  }
}

/**
 * What a finished handler returned, as the task's output: JSON, bounded. The
 * HEAD is kept, unlike a log's tail — a result reads from the top, where its
 * shape is, and its end is the part least worth the space.
 */
export function describeResult(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const text = jsonOf(value)
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= TAIL_MAX_BYTES) {
    return text
  }
  const head = bytes.subarray(0, TAIL_MAX_BYTES).toString('utf8')
  return `${head}\n… (truncated — the whole result is ${bytes.length} bytes)`
}

function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    // Circular, or holding something JSON cannot carry.
    return String(value)
  }
}
