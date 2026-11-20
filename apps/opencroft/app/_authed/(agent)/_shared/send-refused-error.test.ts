// What a sent message kept on screen says when it did not get there. Its
// words are not in the composer, so nothing it says may send the reader there.
import assert from 'node:assert/strict'
import test from 'node:test'

import { outgoingFailureNotice, SendRefusedError, sendFailureNotice } from './send-refused-error'

const sendsToComposer = /composer/i

test('a kept message that failed for an unknown reason says it was not sent, and not that it is in the composer', () => {
  const notice = outgoingFailureNotice(new TypeError('Failed to fetch'))
  assert.doesNotMatch(`${notice.title} ${notice.hint ?? ''}`, sendsToComposer)
  assert.deepEqual(notice, { title: "Your message wasn't sent.", details: 'Failed to fetch' })
})

test('the general send notice, for a message given back, does point at the composer', () => {
  // The other half of the pair: the hint the kept message leaves off is there.
  assert.match(sendFailureNotice(new TypeError('Failed to fetch')).hint ?? '', sendsToComposer)
})

test('a kept message keeps the remedy of a failure a rule recognises', () => {
  const notice = outgoingFailureNotice(new Error('Unknown session: session-1'))
  assert.equal(notice.title, "The agent's session was lost, most likely in a server restart.")
  assert.ok(notice.hint, 'with that rule’s hint')
  assert.doesNotMatch(notice.hint, sendsToComposer)
})

test('a kept message that was refused says the refusal, as it was given', () => {
  assert.deepEqual(outgoingFailureNotice(new SendRefusedError('That agent is not part of this group chat.')), {
    title: 'That agent is not part of this group chat.',
  })
})
