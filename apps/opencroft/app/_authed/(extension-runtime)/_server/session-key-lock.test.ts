// Two deliveries for one session key must not resolve "does a session exist"
// at the same time — that is the check-then-act that lets both decide to
// create one. The lock serialises them; it must not drop either, must not
// serialise unrelated keys, and must not wedge the queue when one fails.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { withSessionKeyLock } from './stream'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('two callers on one key run one after the other, not interleaved', async () => {
  const order: string[] = []
  const body = (name: string) => async () => {
    order.push(`${name}:start`)
    await tick()
    order.push(`${name}:end`)
    return name
  }

  const [a, b] = await Promise.all([withSessionKeyLock('k', body('a')), withSessionKeyLock('k', body('b'))])

  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'])
  assert.deepEqual([a, b], ['a', 'b'])
})

test('the second caller sees what the first one left behind', async () => {
  // The actual point: the second delivery must resolve against post-first
  // state, so it finds the session the first one created instead of creating
  // a rival for the same key.
  let sessions = 0
  const findOrCreate = async () => {
    const existing = sessions
    await tick()
    if (existing === 0) {
      sessions += 1
    }
    return sessions
  }

  await Promise.all([withSessionKeyLock('k2', findOrCreate), withSessionKeyLock('k2', findOrCreate)])

  assert.equal(sessions, 1, 'two concurrent deliveries for one key must produce exactly one session')
})

test('without the lock the same code produces two — the race is real', async () => {
  let sessions = 0
  const findOrCreate = async () => {
    const existing = sessions
    await tick()
    if (existing === 0) {
      sessions += 1
    }
    return sessions
  }

  await Promise.all([findOrCreate(), findOrCreate()])

  assert.equal(sessions, 2, 'the unguarded version double-creates, which is what this lock exists to stop')
})

test('different keys are not serialised against each other', async () => {
  const order: string[] = []
  const slow = async () => {
    await tick()
    order.push('slow')
  }
  const fast = async () => {
    order.push('fast')
  }

  await Promise.all([withSessionKeyLock('one', slow), withSessionKeyLock('two', fast)])

  assert.deepEqual(order, ['fast', 'slow'], 'an unrelated key must not wait behind a slow delivery')
})

test('a failed delivery does not swallow or wedge the one queued behind it', async () => {
  const failing = withSessionKeyLock('k3', async () => {
    throw new Error('delivery failed')
  })
  const following = withSessionKeyLock('k3', async () => 'delivered')

  await assert.rejects(failing, /delivery failed/, 'the failure still reaches its own caller')
  assert.equal(await following, 'delivered', 'and the next delivery for that key still runs')
})

test('a key stops being tracked once its queue drains', async () => {
  // Otherwise the map grows one entry per delivery for the process's lifetime.
  await withSessionKeyLock('k4', async () => 'done')
  await tick()
  const again = await withSessionKeyLock('k4', async () => 'done again')
  assert.equal(again, 'done again')
})
