import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_MESSAGE_TEXT_BYTES, OVERSIZED_TEXT_REFUSAL, oversizedTextNotice } from './message-size'

test('text up to the limit passes, and one byte more is refused with its size', () => {
  assert.equal(oversizedTextNotice('a'.repeat(MAX_MESSAGE_TEXT_BYTES)), null)
  assert.equal(
    oversizedTextNotice('a'.repeat(MAX_MESSAGE_TEXT_BYTES + 1)),
    'This message is 1.0 MiB of text, over the 1.0 MiB a message can carry. Shorten it, or attach pictures instead of pasting them as text.',
  )
  assert.match(oversizedTextNotice('a'.repeat(3 * 1024 * 1024)) ?? '', /^This message is 3\.0 MiB of text/)
})

test('the refusal mapped from its code says the same limit and remedy, without a size', () => {
  assert.equal(
    OVERSIZED_TEXT_REFUSAL,
    "This message's text is over the 1.0 MiB a message can carry. Shorten it, or attach pictures instead of pasting them as text.",
  )
})

test('the limit is in UTF-8 bytes, not characters', () => {
  // '€' is three bytes: half the limit in characters is half again over it in
  // bytes, which a count of characters would let through.
  assert.equal(oversizedTextNotice('€'.repeat(MAX_MESSAGE_TEXT_BYTES / 4)), null)
  assert.notEqual(oversizedTextNotice('€'.repeat(MAX_MESSAGE_TEXT_BYTES / 2)), null)
})
