// What a space route answers for a space that does not exist.
//
// The loaders fetch the space list and the space's app data concurrently, and
// the data request rejects with `Unknown space: <slug>` for a space that is not
// there. If that rejection decided the answer, the route would answer 500 with
// the internal message on screen instead of leaving for the root.
//
// So the thing worth testing is which of two concurrent outcomes decides the
// answer, and that is exactly what a test can hold still and a type cannot.

import assert from 'node:assert/strict'
import test from 'node:test'

import { isNotFound, isRedirect } from '@tanstack/react-router'

import { missingAddress, settleSpaceRoute } from '@/app/_authed/(space)/_lib/space-route'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

function space(slug: string): SpaceSummary {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    pinned: false,
    icon: 'preset:rocket:blue',
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

function isMissingAddress(error: unknown): boolean {
  return isRedirect(error) && error.options.to === '/' && error.options.replace === true
}

// The answer itself: the root, replacing the dead entry, and not a not-found
// signal the router would draw its own "Not Found" for.
test('a missing address redirects to the root and replaces the history entry', () => {
  const answer = missingAddress()

  assert.equal(isMissingAddress(answer), true)
  assert.equal(isNotFound(answer), false)
})

// The data request rejects the way listSpaceApps really does, and it rejects
// FIRST -- so a helper that let the rejection decide would surface
// `Unknown space: ghost` instead of the redirect.
//
// This also pins that the losing rejection is still handled: settle the space
// verdict without consuming the data promise and its rejection is unhandled,
// which takes the whole test process down rather than failing politely.
test('an unknown space redirects to the root even when the app data rejects first', async () => {
  const error = await caught(() =>
    settleSpaceRoute('ghost', Promise.resolve(SPACES), Promise.reject(new Error('Unknown space: ghost'))),
  )

  assert.equal(isMissingAddress(error), true)
  assert.doesNotMatch(String(error), /Unknown space/, 'the internal message must not travel with the redirect')
})

// The add-app route's shape: its loader wants nothing from the space, so
// nothing rejects and only the space list can tell the slug is unknown.
test('an unknown space redirects to the root even when nothing rejects at all', async () => {
  const error = await caught(() => settleSpaceRoute('ghost', Promise.resolve(SPACES), Promise.resolve(['an app'])))

  assert.equal(isMissingAddress(error), true)
})

// Swallowing every failure into a redirect once any request rejects would hide
// real faults. A space that EXISTS must still surface its own failures as
// themselves.
test('a real failure is not rewritten into a redirect when the space exists', async () => {
  const boom = new Error('the database is unreachable')
  const error = await caught(() => settleSpaceRoute('default', Promise.resolve(SPACES), Promise.reject(boom)))

  assert.equal(error, boom)
})

// Failing to list the spaces at all is not evidence that a space is missing.
test('a failure to list spaces propagates rather than becoming a redirect', async () => {
  const boom = new Error('listSpaces failed')
  const error = await caught(() => settleSpaceRoute('default', Promise.reject(boom), Promise.resolve('data')))

  assert.equal(error, boom)
})

test('a space that exists returns the space, the full list and the data', async () => {
  const result = await settleSpaceRoute('service', Promise.resolve(SPACES), Promise.resolve({ apps: 2 }))

  assert.equal(result.space.slug, 'service')
  assert.equal(result.space.id, 'id-service')
  assert.deepEqual(result.spaces, SPACES)
  assert.deepEqual(result.data, { apps: 2 })
})
