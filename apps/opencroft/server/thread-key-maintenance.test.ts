import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { maintainThreadKeys } from './thread-key-maintenance'

test('a start whose migration failed does not sweep, and says so', async (t) => {
  const errors = t.mock.method(console, 'error', () => {})
  let swept = false
  await maintainThreadKeys({
    migrate: async () => false,
    sweep: async () => {
      swept = true
    },
  })
  assert.equal(swept, false, 'state a failed migration left under a half-moved key must not be read as orphaned')
  assert.deepEqual(
    errors.mock.calls.map((call) => call.arguments),
    [['[startup] orphan sweep skipped: thread-key migration failed this start']],
  )
})

test('a start whose migration completed sweeps after it', async () => {
  const order: string[] = []
  await maintainThreadKeys({
    migrate: async () => {
      order.push('migrate')
      return true
    },
    sweep: async () => {
      order.push('sweep')
    },
  })
  assert.deepEqual(order, ['migrate', 'sweep'])
})
