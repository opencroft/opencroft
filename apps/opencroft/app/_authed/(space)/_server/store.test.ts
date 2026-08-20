// Exercises the real database (embedded PGlite by default) — see @opencroft/db's
// test-env for how this stays off the shared dev/production database regardless
// of the ambient environment.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { GraphConflictError, getSpacesRegistry } from './store'

async function freshSpace(slug: string) {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  return registry.create(slug, slug, { nodes: [], edges: [] })
}

// A timestamp that can never equal a row's real `updatedAt`, used to force the
// conflict branch deterministically instead of racing the system clock.
const NEVER_MATCHES = '2000-01-01T00:00:00.000Z'

test('saveGraph without expectedUpdatedAt overwrites unconditionally (backward compatible)', async () => {
  const registry = getSpacesRegistry()
  const space = await freshSpace(`store-test-unconditional-${crypto.randomUUID()}`)
  const graph = { nodes: [{ id: 'a', type: 'x', position: { x: 0, y: 0 }, data: {} }], edges: [] }
  const result = await registry.saveGraph(space.slug, graph)
  assert.ok(result)
  assert.deepEqual(result.graph.nodes, graph.nodes)
})

test('saveGraph with the current expectedUpdatedAt succeeds', async () => {
  const registry = getSpacesRegistry()
  const space = await freshSpace(`store-test-match-${crypto.randomUUID()}`)
  const graph = { nodes: [{ id: 'a', type: 'x', position: { x: 0, y: 0 }, data: {} }], edges: [] }
  const result = await registry.saveGraph(space.slug, graph, space.updatedAt.toISOString())
  assert.ok(result)
  assert.deepEqual(result.graph.nodes, graph.nodes)
})

test('saveGraph with a stale expectedUpdatedAt throws GraphConflictError and leaves the stored graph untouched', async () => {
  const registry = getSpacesRegistry()
  const space = await freshSpace(`store-test-stale-${crypto.randomUUID()}`)
  const rejectedGraph = { nodes: [{ id: 'should-not-land', type: 'x', position: { x: 0, y: 0 }, data: {} }], edges: [] }
  await assert.rejects(() => registry.saveGraph(space.slug, rejectedGraph, NEVER_MATCHES), GraphConflictError)
  const current = registry.getBySlug(space.slug)
  assert.deepEqual(current?.graph.nodes, [])
})

test('saveGraph rejects a writer whose version predates a real concurrent write, without losing the winner', async () => {
  const registry = getSpacesRegistry()
  const space = await freshSpace(`store-test-race-${crypto.randomUUID()}`)
  const staleVersion = space.updatedAt.toISOString()
  // Guarantee the winner's write lands in a later millisecond than staleVersion —
  // updatedAt is millisecond-precision (see the trade-off comment in saveGraph),
  // so without this the two writes could tie and this assertion would be flaky.
  await delay(5)

  // A concurrent writer (another tab / MCP call) saves first.
  const winner = { nodes: [{ id: 'winner', type: 'x', position: { x: 0, y: 0 }, data: {} }], edges: [] }
  await registry.saveGraph(space.slug, winner)

  // Our save was built from the pre-race snapshot, so it must be rejected, not merged.
  const loser = { nodes: [{ id: 'loser', type: 'x', position: { x: 0, y: 0 }, data: {} }], edges: [] }
  await assert.rejects(() => registry.saveGraph(space.slug, loser, staleVersion), GraphConflictError)

  const current = registry.getBySlug(space.slug)
  assert.deepEqual(current?.graph.nodes, winner.nodes)
})

// ---------------------------------------------------------------------------
// RENAMING MOVES A SPACE'S ADDRESS. The slug is in canvas URLs, in the stored
// active-space setting, and in whatever an extension was configured with -- so
// a rename that left it behind is the same defect a renamed group chat had, and
// the freed address has to keep resolving.
// ---------------------------------------------------------------------------

test('renaming a space moves its slug, and the freed one still resolves to it', async () => {
  const registry = getSpacesRegistry()
  const original = `store-rename-${crypto.randomUUID()}`
  const space = await freshSpace(original)

  const renamed = await registry.rename(original, 'Delivery Crew')
  assert.ok(renamed)
  assert.equal(renamed.name, 'Delivery Crew')
  assert.equal(renamed.slug, 'delivery-crew', 'the address follows the name -- what the rename is for')

  assert.equal(registry.getBySlug('delivery-crew')?.id, space.id)
  assert.equal(registry.getBySlug(original)?.id, space.id, 'a bookmarked URL must still land on the space it named')
  assert.equal(
    registry.list().some((s) => s.slug === original),
    false,
    'the freed slug resolves but is not a space of its own',
  )

  // Renaming again works from the current address and keeps both freed ones.
  const again = await registry.rename('delivery-crew', 'Delivery Crew Two')
  assert.ok(again)
  assert.equal(again.slug, 'delivery-crew-two')
  assert.equal(registry.getBySlug(original)?.id, space.id)
  assert.equal(registry.getBySlug('delivery-crew')?.id, space.id)
})

test('a rename that does not move the slug leaves the address alone', async () => {
  const registry = getSpacesRegistry()
  const slug = `store-rename-same-${crypto.randomUUID()}`
  await freshSpace(slug)

  // The name changes; its slug is what the space already answers to, so the
  // address must not be suffixed into a new one.
  const renamed = await registry.rename(slug, slug.toUpperCase())
  assert.ok(renamed)
  assert.equal(renamed.slug, slug)
})

test('a live space outranks a freed address, and taking one drops the alias', async () => {
  const registry = getSpacesRegistry()
  const original = `store-rename-reuse-${crypto.randomUUID()}`
  const first = await freshSpace(original)
  const moved = await registry.rename(original, `moved ${crypto.randomUUID()}`)
  assert.ok(moved)
  assert.equal(registry.getBySlug(original)?.id, first.id)

  // A second space now claims exactly the address the first one freed.
  const second = await registry.create(original, original, { nodes: [], edges: [] })
  assert.equal(
    registry.getBySlug(original)?.id,
    second.id,
    'the space holding the address now is the answer, not the one that used to',
  )

  // And the alias is gone rather than merely outranked at read time.
  await registry.remove(second.slug)
  assert.equal(registry.getBySlug(original), null)
})

test('renaming the active space moves the stored active slug with it', async () => {
  const registry = getSpacesRegistry()
  const original = `store-rename-active-${crypto.randomUUID()}`
  await freshSpace(original)
  await registry.setActiveSlug(original)

  const renamed = await registry.rename(original, `Active ${crypto.randomUUID()}`)
  assert.ok(renamed)
  assert.equal(
    await registry.getActiveSlug(),
    renamed.slug,
    'left pointing at the freed slug, the next load would silently open a different space',
  )
})
