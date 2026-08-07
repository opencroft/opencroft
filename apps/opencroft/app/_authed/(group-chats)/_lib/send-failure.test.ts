// A send into a removed agent's thread IS refused server-side; what was
// missing was any sign of it on screen. The refusal reached the browser, the
// composer had already cleared itself, and the only trace was a console error
// — indistinguishable from the message being delivered.
//
// Two pieces carry the fix. This one decides whether a failure has copy worth
// showing; the chat hook then displays it and puts the text back. These tests
// cover the first, including the case that made the bug invisible: a refusal
// whose class does NOT survive the RPC boundary and so cannot be recognised by
// `instanceof`.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GENERIC_SEND_FAILURE,
  SendRefusedError,
  sendFailureMessage,
} from '@/app/_authed/(agent)/_shared/send-refused-error'
import { GroupChatAccessError } from '@/app/_authed/(group-chats)/_shared/access-error'
import { threadSendFailure } from './send-failure'

test('a refusal becomes a SendRefusedError carrying the shared copy', () => {
  const refusal = new GroupChatAccessError('agent-not-a-member', 'That agent is no longer a member of this group chat')
  const mapped = threadSendFailure(refusal)

  assert.ok(mapped instanceof SendRefusedError, 'a refusal must be marked as one so its copy is shown verbatim')
  assert.equal((mapped as SendRefusedError).message, 'That agent is not part of this group chat.')
  assert.equal(sendFailureMessage(mapped), 'That agent is not part of this group chat.')
})

// The shape that actually arrives in the browser. `createServerFn` rebuilds a
// thrown error as a plain Error — the subclass does not survive — so anything
// recognising refusals by `instanceof GroupChatAccessError` would miss every
// real one. This asserts the round-trip shape, not the convenient one.
test('a refusal that lost its class crossing the RPC boundary is still recognised', () => {
  const overTheWire = Object.assign(new Error('That agent is no longer a member of this group chat'), {
    name: 'GroupChatAccessError',
    code: 'agent-not-a-member',
  })

  const mapped = threadSendFailure(overTheWire)
  assert.ok(mapped instanceof SendRefusedError, 'the wire shape is what real refusals look like and must be handled')
  assert.equal((mapped as SendRefusedError).message, 'That agent is not part of this group chat.')
})

test('an ordinary failure is passed through untouched and reads as a generic failure', () => {
  const network = new Error('Failed to fetch')
  const mapped = threadSendFailure(network)

  assert.equal(mapped, network, 'a fault must not be rewritten into a refusal — it sends people to the wrong fix')
  assert.equal(sendFailureMessage(mapped), GENERIC_SEND_FAILURE)
})

test('an error merely shaped like a refusal is not treated as one', () => {
  const impostor = Object.assign(new Error('nope'), { name: 'SomethingElse', code: 'agent-not-a-member' })
  assert.equal(threadSendFailure(impostor), impostor)
})

test('the generic copy says the message was kept, because it is', () => {
  // The wording is load-bearing: the composer text is restored on every failed
  // send, so telling the reader so is what makes the failure recoverable
  // rather than just visible.
  assert.match(GENERIC_SEND_FAILURE, /composer/i)
})
