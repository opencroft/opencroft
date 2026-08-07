// Proves the client-side error contract against a seroval round trip.
//
// READ THIS BEFORE RELYING ON IT FOR A SERVER FUNCTION. This file's header
// used to claim it exercised "the same seroval round trip `createServerFn`
// uses". That premise is wrong, and it caused a real bug: we captured the actual
// network payload for a thrown server-function error and it is
// `{"message":"…"},"c":"$TSR/Error"}` — a plain Error carrying its message and
// NOTHING else. `name` and `code` are gone. Seroval preserves them, as the
// tests below correctly show; the server-function error path does not put the
// error through seroval intact, so what those tests prove is a property of
// seroval, not of the boundary a browser actually sees.
//
// The helpers here are still right for errors that reach the client with
// their fields (a rethrow inside the same process, an SSR loader), and the
// `instanceof` finding below still holds. But a REFUSAL THAT HAS TO BE
// IDENTIFIED IN THE BROWSER MUST BE RETURNED AS DATA, not thrown — see
// `_server/actions.ts`'s SendThreadMessageResult and `_lib/send-failure.ts`.
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
  const thrown = new GroupChatAccessError('not-found', 'Not available')
  const received = await overTheWire(thrown)

  assert.equal(
    received instanceof GroupChatAccessError,
    false,
    'if this ever becomes true the recorded contract changed; the helper is still correct, but the comment explaining it is not',
  )
  assert.ok(received instanceof Error, 'it does arrive as a plain Error')
})

// Through SEROVAL specifically. This is not what a thrown server-function
// error looks like in the browser — see the header.
test('name and code survive a seroval round trip, and the helper reads them', async () => {
  for (const code of ['unauthenticated', 'not-found', 'agent-not-a-member'] as const) {
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
  for (const value of [null, undefined, 'not-found', 42, {}, { name: 'GroupChatAccessError' }]) {
    assert.equal(groupChatAccessCode(value), null)
  }
})

// An error carrying the right name but a code this build does not know about
// must not be reported with a wrong code — it falls through to null, and the
// caller shows its generic message.
test('an unrecognised code does not masquerade as a known one', async () => {
  const rogue = new GroupChatAccessError('not-found', 'x')
  ;(rogue as unknown as { code: string }).code = 'some-future-code'
  const received = await overTheWire(rogue)
  assert.equal(groupChatAccessCode(received), null)
})

// This file used to assert that two DIFFERENT codes mapped to the same copy,
// and called that indistinguishability. It was not: the server was still
// sending two codes and two messages, and a console capture read them
// straight off the response. Matching copy cannot fix a distinguishable
// response — it only hides it from the screen.
//
// The real property now lives in model.test.ts, where two genuine refusals are
// compared to each other. What belongs HERE is the client half: whatever the
// server sends for "you cannot have this" must reach the user as one message
// that says nothing about existence or membership.
test('the refusal copy reveals neither existence nor membership', async () => {
  const received = await overTheWire(new GroupChatAccessError('not-found', 'Not available'))
  const shown = groupChatAccessMessage(received)
  assert.ok(shown, 'a refusal must have user-facing copy')
  for (const word of ['not a member', 'member', 'no such', "doesn't exist", 'does not exist']) {
    assert.equal(
      shown.toLowerCase().includes(word),
      false,
      `the copy must not say "${word}" — that is the distinction the collapse removes`,
    )
  }
})

test('the server message is not shown verbatim', async () => {
  // The server's own text is written for logs and may name things a
  // non-member should not be told. The helper returns its own copy.
  const received = await overTheWire(new GroupChatAccessError('not-found', 'chat 7f3a is members-only'))
  const shown = groupChatAccessMessage(received)
  assert.ok(shown)
  assert.equal(shown.includes('7f3a'), false, 'internal detail must not reach the screen')
})
