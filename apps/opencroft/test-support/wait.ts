// Waiting in a test without a fixed time: await the promise itself when there
// is one (`deferred`), and poll a condition only when there is not (`waitFor`).
//
// `waitFor` measures its deadline with `performance.now()` and sleeps through
// `node:timers/promises`. `t.mock.timers` fakes neither (mock-timers.test.ts
// pins that on this Node), so a test that fakes the global `setTimeout` and
// `Date` still gets a real deadline here. A deadline read from `Date` can also
// pass in a few milliseconds when the clock is faked or the host steps it.

import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

const POLL_MS = 5

export interface WaitForOptions {
  /** What is awaited, in words, for the failure message: "the window delivers". */
  what: string
  /** Bounds a failure only: a condition that holds returns at once. */
  timeoutMs?: number
}

/**
 * Polls `condition` until it returns a truthy value, and returns that value.
 * Fails with `what` in the message once `timeoutMs` (default 5 s) of real time
 * has passed. An error thrown by `condition` fails the wait as itself.
 */
export async function waitFor<T>(
  condition: () => T | Promise<T>,
  { what, timeoutMs = 5_000 }: WaitForOptions,
): Promise<T> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await condition()
    if (value) {
      return value
    }
    if (performance.now() >= deadline) {
      assert.fail(`timed out after ${timeoutMs} ms waiting until ${what}`)
    }
    await sleep(POLL_MS)
  }
}

/** A promise the test settles from outside, through `resolve` or `reject`. */
export function deferred<T = void>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>()
}
