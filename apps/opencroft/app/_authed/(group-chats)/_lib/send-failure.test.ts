// Why a refused send is DATA and not a thrown error.
//
// The first attempt at this recognised refusals by reading `name` and `code`
// off the caught error, and the test that "proved" it built the error object
// by hand -- so it asserted a shape nobody had observed on the wire. We then
// captured the real payload: `{"message":"..."},"c":"$TSR/Error"}`. No `name`,
// no `code`, nothing to match on. Every real refusal fell through to the
// generic wording while the test stayed green.
//
// So the first test below pins the ACTUAL serialised shape and asserts that
// field-based recognition cannot work on it. That is the regression: if
// someone reintroduces a client-side branch on `error.code`, this says why it
// will not fire. The rest cover the contract that replaced it.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GENERIC_SEND_FAILURE,
  SendRefusedError,
  sendFailureMessage,
} from '@/app/_authed/(agent)/_shared/send-refused-error'
import { groupChatAccessCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import type { SendThreadMessageResult } from '@/app/_authed/(group-chats)/_server/actions'
import { threadSendRefusal } from './send-failure'

// The shape captured off the network, reconstructed: `createServerFn`
// rebuilds a thrown error as a plain Error carrying its message and nothing
// else. Deliberately NOT given `name`/`code`, because the real one has none.
function asDeliveredToTheBrowser(message: string): Error {
  return new Error(message)
}

test('a thrown refusal arrives with no code to read — which is why it is not thrown any more', () => {
  const overTheWire = asDeliveredToTheBrowser('That agent is no longer a member of this group chat')

  assert.equal(
    groupChatAccessCode(overTheWire),
    null,
    'the serialised error carries no name or code, so field-based recognition cannot identify the refusal — do not branch on it client-side',
  )
  assert.equal(overTheWire.name, 'Error', 'the custom name does not survive the boundary')
  assert.equal(
    (overTheWire as Error & { code?: unknown }).code,
    undefined,
    'nor does the code — the only thing left is the message, and matching on that breaks on the next copy edit',
  )
})

test('a refused result becomes a SendRefusedError carrying the mapped copy', () => {
  const refused: SendThreadMessageResult = { ok: false, code: 'agent-not-a-member' }
  const refusal = threadSendRefusal(refused)

  assert.ok(refusal instanceof SendRefusedError, 'a refusal must be marked as one so its copy is shown verbatim')
  assert.equal(refusal.message, 'That agent is not part of this group chat.')
  assert.equal(sendFailureMessage(refusal), 'That agent is not part of this group chat.')
})

// The bug, stated as an assertion: the reader must get the specific
// sentence, never the fallback, for a refusal the server actually identified.
test('a refused send never reads as the generic failure', () => {
  const refusal = threadSendRefusal({ ok: false, code: 'agent-not-a-member' })
  assert.ok(refusal)
  assert.notEqual(sendFailureMessage(refusal), GENERIC_SEND_FAILURE)
})

test('every refusal code maps to its own copy, not a shared one', () => {
  const codes = ['not-found', 'agent-not-a-member', 'last-user-member', 'unauthenticated'] as const
  const messages = codes.map((code) => {
    const refusal = threadSendRefusal({ ok: false, code })
    assert.ok(refusal)
    return refusal.message
  })
  assert.equal(new Set(messages).size, codes.length, 'each code must produce distinct copy')
  for (const message of messages) {
    assert.notEqual(message, GENERIC_SEND_FAILURE)
  }
})

test('a delivered send produces no refusal at all', () => {
  assert.equal(threadSendRefusal({ ok: true }), null)
})

test('the generic copy says the message was kept, because it is', () => {
  // Load-bearing wording: the composer text is restored on every failed send,
  // so saying so is what makes the failure recoverable rather than just visible.
  assert.match(GENERIC_SEND_FAILURE, /composer/i)
})
