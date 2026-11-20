import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { deferred, waitFor } from './wait'

test('waitFor returns the value once the condition holds', async () => {
  let ready: string | undefined
  void sleep(20).then(() => {
    ready = 'landed'
  })
  assert.equal(await waitFor(() => ready, { what: 'the value lands' }), 'landed')
})

test('waitFor awaits an async condition', async () => {
  let polls = 0
  const value = await waitFor(
    async () => {
      polls += 1
      return polls >= 3 ? polls : 0
    },
    { what: 'the third poll' },
  )
  assert.equal(value, 3)
})

test('waitFor fails at its deadline, naming what it waited for', async () => {
  await assert.rejects(
    waitFor(() => false, { what: 'the flag is set', timeoutMs: 50 }),
    {
      name: 'AssertionError',
      message: 'timed out after 50 ms waiting until the flag is set',
    },
  )
})

test('waitFor fails the wait with the error its condition throws', async () => {
  await assert.rejects(
    waitFor(
      () => {
        throw new Error('the condition broke')
      },
      { what: 'never' },
    ),
    { message: 'the condition broke' },
  )
})

// `timeout` bounds a hang: a waitFor that slept on the faked setTimeout would
// never wake, since nothing ticks the mock while it waits.
test('waitFor runs on real time while the test fakes setTimeout and Date', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  let ready = false
  void sleep(20).then(() => {
    ready = true
  })
  await waitFor(() => ready, { what: 'a real-time event lands' })

  // The faked Date jumps a minute on every poll. A deadline read from it
  // would pass on the second poll; a real one does not.
  let polls = 0
  await waitFor(
    () => {
      t.mock.timers.tick(60_000)
      polls += 1
      return polls >= 3
    },
    { what: 'the third poll', timeoutMs: 1_000 },
  )
  assert.equal(polls, 3)
})

test('deferred settles from outside: resolve hands over the value', async () => {
  const gate = deferred<string>()
  gate.resolve('opened')
  assert.equal(await gate.promise, 'opened')
})

test('deferred settles from outside: reject hands over the reason', async () => {
  const gate = deferred()
  gate.reject(new Error('refused'))
  await assert.rejects(gate.promise, { message: 'refused' })
})
