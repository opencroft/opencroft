// Why a refused member add/remove is DATA and not a thrown error.
//
// The dialog used to recognise refusals by reading `name`/`code` off a caught
// error (`failureMessage` -> `groupChatAccessMessage`). A manual-test
// item-7 pass observed the real payload for the last-user-member refusal:
// "That member could not be removed." -- the dialog's generic fallback, not
// the mapped "The last person in a group chat cannot be removed." A thrown
// server-function error reaches the browser as `$TSR/Error` carrying only
// `message`; no `name`, no `code`, nothing to match on. Every refusal fell
// through to the fallback, and it went unnoticed only because the fallback still
// reads sensibly.
//
// So the first test below pins the ACTUAL serialised shape and asserts that
// field-based recognition cannot work on it -- mirrors send-failure.test.ts's
// first test for the same reason: it exists so this exact regression cannot
// come back unnoticed. The rest cover the contract that replaced it.

import assert from 'node:assert/strict'
import test from 'node:test'

import { groupChatAccessCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { memberActionRefusal } from '@/app/_authed/(group-chats)/_lib/member-action-refusal'
import type { GroupChatWriteResult } from '@/app/_authed/(group-chats)/_server/actions'

// The shape captured off the network, reconstructed: `createServerFn`
// rebuilds a thrown error as a plain Error carrying its message and nothing
// else. Deliberately NOT given `name`/`code`, because the real one has none.
function asDeliveredToTheBrowser(message: string): Error {
  return new Error(message)
}

test('a thrown refusal arrives with no code to read — which is why it is not thrown any more', () => {
  const overTheWire = asDeliveredToTheBrowser('The last person in a group chat cannot be removed')

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

test('a refused result maps straight to the same copy the read surfaces show', () => {
  const refused: GroupChatWriteResult = { ok: false, code: 'last-user-member' }
  assert.equal(memberActionRefusal(refused), 'The last person in a group chat cannot be removed.')
})

// The bug, stated as an assertion: the reader must get the specific
// sentence, never the dialog's generic fallback, for a refusal the server
// actually identified.
test('a recognised refusal never reads as the dialog fallback', () => {
  const refusal = memberActionRefusal({ ok: false, code: 'last-user-member' })
  assert.ok(refusal)
  assert.notEqual(refusal, 'That member could not be removed.')
  assert.notEqual(refusal, 'That member could not be added.')
})

test('every refusal code maps to its own copy, not a shared one', () => {
  const codes = ['unauthenticated', 'not-found', 'agent-not-a-member', 'last-user-member'] as const
  const messages = codes.map((code) => {
    const refusal = memberActionRefusal({ ok: false, code })
    assert.ok(refusal)
    return refusal
  })
  assert.equal(new Set(messages).size, codes.length, 'each code must produce distinct copy')
})

test('a successful add/remove produces no refusal at all', () => {
  assert.equal(memberActionRefusal({ ok: true }), null)
})
