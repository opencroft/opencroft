import assert from 'node:assert/strict'
import test from 'node:test'

import { turnsPerKey } from './turns-per-key'

test('a run under a key starts once the run queued before it under that key has settled', async () => {
  const inTurn = turnsPerKey()
  const order: string[] = []
  let releaseFirst = () => {}
  const first = inTurn('store:deploy', async () => {
    order.push('first started')
    await new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    order.push('first ended')
  })
  const second = inTurn('store:deploy', async () => {
    order.push('second started')
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['first started'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first started', 'first ended', 'second started'])
})

test('a run that fails does not hold back the next run under the same key', async () => {
  const inTurn = turnsPerKey()
  const failed = inTurn('store:deploy', async () => {
    throw new Error('first failed')
  })
  const next = inTurn('store:deploy', async () => 'second ran')
  await assert.rejects(failed, { message: 'first failed' })
  assert.equal(await next, 'second ran')
})

test('runs under different keys do not wait for each other', async () => {
  const inTurn = turnsPerKey()
  let releaseFirst = () => {}
  const first = inTurn('store:a', () => new Promise<void>((resolve) => (releaseFirst = resolve)))
  assert.equal(await inTurn('store:b', async () => 'b ran'), 'b ran')
  releaseFirst()
  await first
})
