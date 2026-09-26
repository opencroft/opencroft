import assert from 'node:assert/strict'
import test from 'node:test'

import { deliveryNoteBlock, hasUnresolvedToolCalls, isDeliveryNote } from './delivery-note'
import type { ChatEvent } from './types'

const call = (toolCallId: string, status = 'pending'): ChatEvent => ({
  kind: 'tool_call',
  toolCallId,
  title: toolCallId,
  status,
})
const update = (toolCallId: string, status?: string): ChatEvent => ({
  kind: 'tool_update',
  toolCallId,
  ...(status ? { status } : {}),
})

test('calls announced without a status are pending, with nothing running', () => {
  // ACP's tool_call status is optional and defaults to pending. Two calls
  // issued in one message, neither started, is the case the note exists for.
  const bare = (toolCallId: string) => ({ kind: 'tool_call', toolCallId, title: toolCallId }) as unknown as ChatEvent
  assert.equal(hasUnresolvedToolCalls([bare('a'), bare('b')]), true)
  assert.equal(hasUnresolvedToolCalls([bare('a'), update('a', 'completed')]), false, 'until it reports an end')
})

test('a call issued and not yet answered is unresolved', () => {
  assert.equal(hasUnresolvedToolCalls([{ kind: 'user', text: 'go' }, call('a')]), true)
})

test('a call waiting behind a running one counts too', () => {
  // The case the note exists for: the running call completes, and the one
  // queued behind it in the same message is still out.
  assert.equal(
    hasUnresolvedToolCalls([call('a'), call('b'), update('a', 'in_progress'), update('a', 'completed')]),
    true,
  )
})

test('calls that all reached a terminal status leave nothing unresolved', () => {
  assert.equal(hasUnresolvedToolCalls([call('a'), call('b'), update('a', 'completed'), update('b', 'failed')]), false)
})

test('an update without a status leaves the call as it was', () => {
  assert.equal(hasUnresolvedToolCalls([call('a'), update('a', 'completed'), update('a')]), false)
  assert.equal(hasUnresolvedToolCalls([call('a'), update('a')]), true)
})

test('only the current turn counts', () => {
  // A call an earlier turn never closed is that turn's loose end, not
  // something this steer can cancel.
  assert.equal(hasUnresolvedToolCalls([call('old'), { kind: 'turn_end', stopReason: 'end_turn' }, call('new')]), true)
  assert.equal(
    hasUnresolvedToolCalls([call('old'), { kind: 'turn_end', stopReason: 'end_turn' }, { kind: 'user', text: 'hi' }]),
    false,
  )
})

test('no tool calls at all is not unresolved', () => {
  assert.equal(hasUnresolvedToolCalls([]), false)
  assert.equal(hasUnresolvedToolCalls([{ kind: 'user', text: 'hi' }]), false)
})

test('the block carries the note and is recognised as one; ordinary text is not', () => {
  const block = deliveryNoteBlock('pending calls may be skipped')
  assert.equal(block.type, 'text')
  const text = block.type === 'text' ? block.text : ''
  assert.match(text, /pending calls may be skipped/)
  assert.equal(isDeliveryNote(text), true)
  assert.equal(isDeliveryNote(`  \n${text}`), false, 'only the exact block is a note')
  assert.equal(isDeliveryNote(`${text}\nand then I said more`), false, 'text after the block makes it a message')
  assert.equal(
    isDeliveryNote('<delivery-note>\nsomething I typed myself'),
    false,
    'a message that merely starts with the tag is a message',
  )
  assert.equal(isDeliveryNote('please read the <delivery-note> tag docs'), false, 'a mention mid-text is a message')
  assert.equal(isDeliveryNote('what changed?'), false)
})
