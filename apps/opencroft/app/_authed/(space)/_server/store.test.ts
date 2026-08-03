// Exercises the real database (embedded PGlite by default). Run with an
// isolated PGLITE_PATH so these tests don't touch the shared dev database, e.g.:
//   PGLITE_PATH=$(mktemp -d) node_modules/.bin/tsx --test app/\(space\)/_server/store.test.ts
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
