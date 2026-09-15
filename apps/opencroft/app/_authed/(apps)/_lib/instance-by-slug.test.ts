import assert from 'node:assert/strict'
import test from 'node:test'

import { instanceBySlug } from './instance-by-slug'

const A_UUID = '550e8400-e29b-41d4-a716-446655440000'

const REPORTS = { id: 'b9f1c2d4-0000-4000-8000-000000000001', slug: 'reports' }
// Not a contrivance: `slugify` admits exactly [a-z0-9-], which is exactly the
// alphabet a uuid is written in, so an app named after one gets a slug that is
// one. This row is what makes the two key spaces observably overlap.
const NAMED_LIKE_A_UUID = { id: 'b9f1c2d4-0000-4000-8000-000000000002', slug: A_UUID }
const WHOSE_ID_IS_THAT_UUID = { id: A_UUID, slug: 'something-else' }

test('the slug names the instance', () => {
  assert.equal(instanceBySlug([REPORTS, NAMED_LIKE_A_UUID], 'reports'), REPORTS)
})

test('a uuid in the url names nothing, so the address 404s', () => {
  assert.equal(instanceBySlug([REPORTS], REPORTS.id), undefined)
})

// The case that says why both spellings cannot be accepted here. One string,
// two rows that could answer to it: the app whose SLUG is that uuid, and the
// app whose ID is. Adding `|| entry.id === slug` does not widen the match, it
// changes which app the url opens -- silently, and toward the one nobody named.
test('a uuid-shaped slug belongs to the app that is NAMED it, not the one whose id it is', () => {
  const found = instanceBySlug([WHOSE_ID_IS_THAT_UUID, NAMED_LIKE_A_UUID], A_UUID)
  assert.equal(found, NAMED_LIKE_A_UUID, 'matched as a slug')
  assert.notEqual(found, WHOSE_ID_IS_THAT_UUID, 'and never as an id, whichever comes first in the list')
})

test('nothing matches an app the space does not hold', () => {
  assert.equal(instanceBySlug([REPORTS], 'no-such-app'), undefined)
  assert.equal(instanceBySlug([], 'reports'), undefined)
})
