// The mapping a type checker cannot police.
//
// A thread id and a session key are both `string`, so returning the wrong one
// type checks — verified, not assumed: swapping the field at the call site left
// the whole workspace typecheck green. The symptom would be a Stop process menu
// item that quietly does nothing, which reads as an agent-layer fault rather
// than a wiring one. So the first test asserts the returned value is the
// session key AND is not the id, which is the assertion that goes red.

import assert from 'node:assert/strict'
import test from 'node:test'

import { threadSessionKey } from './thread-session-key'

const threads = [
  { id: 'thread-one', sessionKey: 'group-chat:demo:agent-one:first' },
  { id: 'thread-two', sessionKey: 'group-chat:demo:agent-two:second' },
]

test('resolves a row to that thread session key, not to its id', () => {
  const resolved = threadSessionKey(threads, 'thread-one')

  assert.equal(resolved, 'group-chat:demo:agent-one:first')
  assert.notEqual(resolved, 'thread-one')
})

test('picks the row that was clicked, not merely the first one', () => {
  assert.equal(threadSessionKey(threads, 'thread-two'), 'group-chat:demo:agent-two:second')
})

// A row can leave the list between render and click — another member deleting
// the thread, or a reload landing mid-gesture. The caller needs a value it can
// branch on rather than a key belonging to whatever happened to be at that
// index, so an unknown id resolves to nothing at all.
test('resolves to undefined for an id the list no longer holds', () => {
  assert.equal(threadSessionKey(threads, 'thread-gone'), undefined)
  assert.equal(threadSessionKey([], 'thread-one'), undefined)
})
