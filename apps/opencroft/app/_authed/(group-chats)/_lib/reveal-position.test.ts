import assert from 'node:assert/strict'
import test from 'node:test'

import { parseRevealPosition } from '@/app/_authed/(group-chats)/_lib/reveal-position'

test('a whole number is kept, zero included', () => {
  assert.equal(parseRevealPosition(7), 7)
  assert.equal(parseRevealPosition(0), 0)
})

test('anything that is not a whole number is dropped', () => {
  for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', '', null, undefined, true, {}, [3]]) {
    assert.equal(parseRevealPosition(value), undefined, `for ${String(value)}`)
  }
})
