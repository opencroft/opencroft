// Proves the client-side error contract against the REAL wire format.
//
// The point of this file is that it does not hand-build a plausible-looking
// error object and check the helper reads it. It puts a genuine
// GroupChatAccessError through the same seroval round trip `createServerFn`
// uses, and asserts against whatever comes out the other side — including the
// part that is easy to get wrong, that `instanceof` no longer holds there.
//
// No database here, and that is now structurally true rather than a hope: the
// error class lives in `_shared/access-error.ts`, which imports nothing, so
// this test runs without PGlite ever being opened.

import assert from 'node:assert/strict'
import test from 'node:test'

import { fromCrossJSON, toCrossJSONAsync } from 'seroval'

import {
  groupChatAccessCode,
  groupChatAccessMessage,
  isGroupChatAccessError,
} from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { GroupChatAccessError } from '@/app/_authed/(group-chats)/_shared/access-error'

/** What the browser actually receives for a thrown server-function error. */
async function overTheWire<T>(value: T): Promise<unknown> {
  const encoded = await toCrossJSONAsync(value, { refs: new Map() })
  return fromCrossJSON(encoded, { refs: new Map() })
}

test('instanceof does NOT survive the RPC boundary — the whole reason this helper exists', async () => {
  const thrown = new GroupChatAccessError('not-a-member', 'You are not a member of this group chat')
  const received = await overTheWire(thrown)

  assert.equal(
    received instanceof GroupChatAccessError,
    false,
    'if this ever becomes true the recorded contract changed; the helper is still correct, but the comment explaining it is not',
  )
  assert.ok(received instanceof Error, 'it does arrive as a plain Error')
})

test('name and code do survive, and the helper reads them', async () => {
  for (const code of ['unauthenticated', 'not-a-member', 'not-found', 'agent-not-a-member'] as const) {
    const received = await overTheWire(new GroupChatAccessError(code, `message for ${code}`))
    assert.equal(groupChatAccessCode(received), code, `${code} must survive the round trip`)
    assert.equal(isGroupChatAccessError(received), true)
  }
})

test('an unrelated error is not reported as an access refusal', async () => {
  const received = await overTheWire(new Error('the database is on fire'))
  assert.equal(groupChatAccessCode(received), null, 'a plain Error must not be read as a refusal')
  assert.equal(isGroupChatAccessError(received), false)
  assert.equal(groupChatAccessMessage(received), null, 'callers fall back to their own copy for this')
})

test('non-error values are handled rather than thrown on', () => {
  for (const value of [null, undefined, 'not-a-member', 42, {}, { name: 'GroupChatAccessError' }]) {
    assert.equal(groupChatAccessCode(value), null)
  }
})

// An error carrying the right name but a code this build does not know about
// must not be reported with a wrong code — it falls through to null, and the
// caller shows its generic message.
test('an unrecognised code does not masquerade as a known one', async () => {
  const rogue = new GroupChatAccessError('not-a-member', 'x')
  ;(rogue as unknown as { code: string }).code = 'some-future-code'
  const received = await overTheWire(rogue)
  assert.equal(groupChatAccessCode(received), null)
})

// THE LEAK THAT WOULD MOVE FROM THE API TO THE SCREEN.
//
// The server refuses not-found and not-a-member identically so a non-member
// cannot learn which ids are real. Different copy here would give that back.
test('not-found and not-a-member read identically to the user', async () => {
  const notFound = await overTheWire(new GroupChatAccessError('not-found', 'No such group chat'))
  const notMember = await overTheWire(new GroupChatAccessError('not-a-member', 'You are not a member'))

  const a = groupChatAccessMessage(notFound)
  const b = groupChatAccessMessage(notMember)
  assert.ok(a, 'not-found must have user-facing copy')
  assert.equal(a, b, 'the two must be indistinguishable on screen, exactly as they are on the wire')
})

test('the server message is not shown verbatim', async () => {
  // The server's own text is written for logs and may name things a
  // non-member should not be told. The helper returns its own copy.
  const received = await overTheWire(new GroupChatAccessError('not-a-member', 'chat 7f3a is members-only'))
  const shown = groupChatAccessMessage(received)
  assert.ok(shown)
  assert.equal(shown.includes('7f3a'), false, 'internal detail must not reach the screen')
})
