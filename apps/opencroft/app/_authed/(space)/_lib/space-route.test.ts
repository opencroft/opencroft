// What a space route answers for a space that does not exist.
//
// The defect these pin was an ORDERING one, not a missing
// check: the loaders already called `notFound()`, but fetched the space list
// and the space's app data concurrently, and the data request rejects with
// `Unknown space: <slug>` for a space that is not there. Under `Promise.all`
// that rejection wins, the `notFound()` below it is never reached, and the
// route answers 500 with the internal message on screen -- while the canvas
// route, which asks for nothing else, answered 404.
//
// So the thing worth testing is which of two concurrent outcomes decides the
// answer, and that is exactly what a test can hold still and a type cannot.

import assert from 'node:assert/strict'
import test from 'node:test'

import { isNotFound } from '@tanstack/react-router'

import { settleSpaceRoute } from '@/app/_authed/(space)/_lib/space-route'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

function space(slug: string): SpaceSummary {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    pinned: false,
    icon: null,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
  }
}

const SPACES = [space('default'), space('service')]

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw, and it returned')
}

// The defect itself. The data request rejects the way listSpaceApps really
// does, and it rejects FIRST -- so a helper that let the rejection decide would
// surface `Unknown space: ghost` instead of a 404.
//
// This also pins that the losing rejection is still handled: settle the space
// verdict without consuming the data promise and its rejection is unhandled,
// which takes the whole test process down rather than failing politely.
test('an unknown space answers notFound even when the app data rejects first', async () => {
  const error = await caught(() =>
    settleSpaceRoute('ghost', Promise.resolve(SPACES), Promise.reject(new Error('Unknown space: ghost'))),
  )

  assert.equal(isNotFound(error), true)
  assert.equal(error instanceof Error, false, 'the internal error must not be what reaches the router')
  assert.doesNotMatch(JSON.stringify(error), /Unknown space/, 'the internal message must not travel with the 404')
})

// The add-app route's shape: its loader wants nothing from the space, so
// nothing ever rejected and it answered 200, rendering the add form under a
// slug that does not exist. Same verdict is owed here.
test('an unknown space answers notFound even when nothing rejects at all', async () => {
  const error = await caught(() => settleSpaceRoute('ghost', Promise.resolve(SPACES), Promise.resolve(['an app'])))

  assert.equal(isNotFound(error), true)
})

// The over-correction this fix could have shipped: swallowing every failure
// into a 404 once any request rejects. A space that EXISTS must still surface
// its own failures as themselves.
test('a real failure is not rewritten into a 404 when the space exists', async () => {
  const boom = new Error('the database is unreachable')
  const error = await caught(() => settleSpaceRoute('default', Promise.resolve(SPACES), Promise.reject(boom)))

  assert.equal(error, boom)
  assert.equal(isNotFound(error), false)
})

// Failing to list the spaces at all is not evidence that a space is missing.
test('a failure to list spaces propagates rather than becoming a 404', async () => {
  const boom = new Error('listSpaces failed')
  const error = await caught(() => settleSpaceRoute('default', Promise.reject(boom), Promise.resolve('data')))

  assert.equal(error, boom)
  assert.equal(isNotFound(error), false)
})

test('a space that exists returns the space, the full list and the data', async () => {
  const result = await settleSpaceRoute('service', Promise.resolve(SPACES), Promise.resolve({ apps: 2 }))

  assert.equal(result.space.slug, 'service')
  assert.equal(result.space.id, 'id-service')
  assert.deepEqual(result.spaces, SPACES)
  assert.deepEqual(result.data, { apps: 2 })
})
