// The loader guard: which failures become a rendered refusal, and which stay
// thrown.
//
// This is the piece the bug turned on. A refusal that escapes as a throw
// is what produced the generic 500 screen and put the raw server message in
// the browser console, so "a refusal never escapes" is the property worth
// pinning down, and "anything else still escapes" is the one that keeps a real
// bug from being reported to the user as an access decision.
//
// No database: the guard only inspects what it catches.

import assert from 'node:assert/strict'
import test from 'node:test'

import { fromCrossJSON, toCrossJSONAsync } from 'seroval'

import { loadOrRefusal } from '@/app/_authed/(group-chats)/_lib/load-or-refusal'
import { GroupChatAccessError } from '@/app/_authed/(group-chats)/_shared/access-error'

/** What a loader actually catches on the client: a seroval-rebuilt error. */
async function overTheWire<T>(value: T): Promise<unknown> {
  const encoded = await toCrossJSONAsync(value, { refs: new Map() })
  return fromCrossJSON(encoded, { refs: new Map() })
}

test('a successful load comes back as data', async () => {
  const result = await loadOrRefusal(async () => ({ chats: [1, 2, 3] }))
  assert.equal(result.refused, false)
  assert.deepEqual(result.refused === false ? result.chats : null, [1, 2, 3])
})

test('a refusal is returned, never thrown — on the server-side shape', async () => {
  // During a server render the loader calls the model in-process, so it
  // catches the real class rather than a rebuilt one.
  const result = await loadOrRefusal(async () => {
    throw new GroupChatAccessError('not-found', 'Not available')
  })
  assert.equal(result.refused, true, 'a refusal must not escape the loader')
  assert.equal(result.refused === true ? result.code : null, 'not-found')
})

test('a refusal is returned, never thrown — on the client-side shape', async () => {
  // After a client transition the same refusal arrives as a plain Error with
  // `name` and `code` copied on. Both paths must behave identically, because
  // the whole defect was the two paths behaving differently.
  const wire = await overTheWire(new GroupChatAccessError('not-found', 'Not available'))
  const result = await loadOrRefusal(async () => {
    throw wire
  })
  assert.equal(result.refused, true, 'the rebuilt refusal must be recognised too')
  assert.equal(result.refused === true ? result.code : null, 'not-found')
})

test('every refusal code the server can send is caught, not just not-found', async () => {
  for (const code of ['unauthenticated', 'not-found', 'agent-not-a-member'] as const) {
    const wire = await overTheWire(new GroupChatAccessError(code, 'Not available'))
    const result = await loadOrRefusal(async () => {
      throw wire
    })
    assert.equal(result.refused, true, `${code} must be caught`)
    assert.equal(result.refused === true ? result.code : null, code)
  }
})

// The other half, and it matters as much: a bug must not be dressed up as an
// access decision. If this ever starts returning `refused: true`, every real
// failure silently becomes "not available" and nothing surfaces it.
test('a non-refusal error is rethrown untouched', async () => {
  const boom = new Error('the database is on fire')
  await assert.rejects(
    () =>
      loadOrRefusal(async () => {
        throw boom
      }),
    (error: unknown) => {
      assert.equal(error, boom, 'the original error must propagate, not a substitute')
      return true
    },
  )
})

test('an error merely shaped like a refusal is not treated as one', async () => {
  // `name` right, `code` not a code this build knows: not something to report
  // as an access decision.
  const impostor = Object.assign(new Error('x'), { name: 'GroupChatAccessError', code: 'made-up' })
  await assert.rejects(() =>
    loadOrRefusal(async () => {
      throw impostor
    }),
  )
})
