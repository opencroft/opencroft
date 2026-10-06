import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  COMPACTION_HOLD_BACKSTOP_MS,
  type CompactionHold,
  endCompactionHold,
  nextCompactionHold,
} from './compaction-hold'

test('the hold lasts while any compaction is in progress and is gone once the last one leaves it', () => {
  const expire = () => assert.fail('no backstop should run')
  let hold: CompactionHold | undefined
  hold = nextCompactionHold(hold, 'a', 'in_progress', expire)
  hold = nextCompactionHold(hold, 'b', 'in_progress', expire)
  hold = nextCompactionHold(hold, 'a', 'completed', expire)
  assert.deepEqual([...(hold?.compactionIds ?? [])], ['b'])
  hold = nextCompactionHold(hold, 'b', 'some-future-status', expire)
  assert.equal(hold, undefined, 'any status other than in_progress ends it')
})

test('a summary chunk keeps a held compaction alive and leaves an unheld one alone', () => {
  const expire = () => assert.fail('no backstop should run')
  assert.equal(nextCompactionHold(undefined, 'a', undefined, expire), undefined)
  const hold = nextCompactionHold(undefined, 'a', 'in_progress', expire)
  assert.equal(nextCompactionHold(hold, 'other', undefined, expire), hold, 'a chunk for another id changes nothing')
  endCompactionHold(hold)
})

test('the backstop runs out only after the full window with no signal, and every signal restarts it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const expired = mock.fn()
  let hold = nextCompactionHold(undefined, 'a', 'in_progress', expired)
  t.mock.timers.tick(COMPACTION_HOLD_BACKSTOP_MS - 1)
  hold = nextCompactionHold(hold, 'a', undefined, expired)
  t.mock.timers.tick(COMPACTION_HOLD_BACKSTOP_MS - 1)
  assert.equal(expired.mock.callCount(), 0, 'the chunk restarted the window')
  t.mock.timers.tick(1)
  assert.equal(expired.mock.callCount(), 1)
  endCompactionHold(hold)
})

test('ending a hold disarms its backstop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const expired = mock.fn()
  const hold = nextCompactionHold(undefined, 'a', 'in_progress', expired)
  assert.equal(nextCompactionHold(hold, 'a', 'completed', expired), undefined)
  t.mock.timers.tick(COMPACTION_HOLD_BACKSTOP_MS)
  assert.equal(expired.mock.callCount(), 0)
})
