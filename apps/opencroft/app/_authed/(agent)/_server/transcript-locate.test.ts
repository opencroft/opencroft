import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatEvent } from 'agent-client/types'

import { locateRecordedEvent, locateTurn } from './transcript-locate'

const user = (text: string): ChatEvent => ({ kind: 'user', text })
const reply = (text: string): ChatEvent => ({ kind: 'agent_message', text })

test('a turn still recorded is located against its recorded event', () => {
  const log = [user('first'), reply('a'), user('second'), reply('b')]
  assert.deepEqual(locateTurn(log, { event: user('second'), fromEnd: 2 }, null), { kind: 'found', index: 2 })
  assert.deepEqual(locateTurn(log, { event: user('never said'), fromEnd: 2 }, null), { kind: 'gone' })
})

test('a trimmed turn the log still holds is located against the indexed question', () => {
  // The log reaches back further than the recording: the session has been
  // open since before the cap trimmed this turn.
  const delivered = '<agent-message author="alice" datetime="2026-01-01T10:00:00.000Z"/>\nthe old question'
  const log = [user(delivered), reply('old answer'), user('newer'), reply('newer answer')]
  const indexed = { role: 'user' as const, text: 'the old question' }
  assert.deepEqual(locateTurn(log, { event: null, fromEnd: 4 }, indexed), { kind: 'found', index: 0 })
})

test('a trimmed turn that came without a question is located by its first chunk', () => {
  const log = [reply('Hello, '), reply('I am here.'), user('hi')]
  const indexed = { role: 'agent' as const, text: 'Hello, I am here.' }
  assert.deepEqual(locateTurn(log, { event: null, fromEnd: 3 }, indexed), { kind: 'found', index: 0 })
})

test('a trimmed turn the log does not reach back to is older than what can be shown', () => {
  const log = [user('newer'), reply('newer answer')]
  const indexed = { role: 'user' as const, text: 'the old question' }
  assert.deepEqual(locateTurn(log, { event: null, fromEnd: 40 }, indexed), { kind: 'older' })
  // In range, but saying something else: not that turn, and nothing else to try.
  assert.deepEqual(locateTurn(log, { event: null, fromEnd: 2 }, indexed), { kind: 'older' })
})

test('a trimmed turn the index does not know is gone', () => {
  assert.deepEqual(locateTurn([user('a')], { event: null, fromEnd: 1 }, null), { kind: 'gone' })
})

test('a recording that is the log tail locates by distance from the end', () => {
  // The log holds more than the recording: the recording was capped at its start.
  const log = [user('dropped by the cap'), reply('a'), user('again'), reply('b'), user('again'), reply('c')]
  assert.equal(locateRecordedEvent(log, { event: user('again'), fromEnd: 4 }), 2)
  assert.equal(locateRecordedEvent(log, { event: user('again'), fromEnd: 2 }), 4)
})

test('when the distance misses, the nearest event with the same words is taken', () => {
  // Two events the recording lost shift its distances by two.
  const log = [user('first'), reply('x'), user('repeat'), reply('y'), user('repeat'), reply('z'), reply('w')]
  assert.equal(locateRecordedEvent(log, { event: user('repeat'), fromEnd: 1 }), 4)
  assert.equal(locateRecordedEvent(log, { event: user('first'), fromEnd: 3 }), 0)
})

test('a log holding nothing like the recorded event locates nothing', () => {
  const log = [user('something else'), reply('first')]
  assert.equal(locateRecordedEvent(log, { event: user('first'), fromEnd: 1 }), null)
  assert.equal(locateRecordedEvent([], { event: user('first'), fromEnd: 1 }), null)
})
