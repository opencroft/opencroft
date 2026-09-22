// Against the real spaces registry on a throwaway database (see
// @opencroft/db's test-env).
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { findTakenGraphIdsImpl } from './actions-impl'
import { getSpacesRegistry } from './store'

async function spaceWith(nodeId: string, edgeId: string): Promise<string> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `taken-ids-${crypto.randomUUID()}`
  await registry.create(slug, slug, {
    nodes: [{ id: nodeId, type: 'localhost', position: { x: 0, y: 0 }, data: {} }],
    edges: [{ id: edgeId, source: nodeId, target: nodeId }],
  })
  return slug
}

test('node and edge ids used by any graph are reported taken; unused ones are not', async () => {
  const node = crypto.randomUUID()
  const edge = crypto.randomUUID()
  const unused = crypto.randomUUID()
  await spaceWith(node, edge)
  const taken = await findTakenGraphIdsImpl({ ids: [node, edge, unused] })
  assert.deepEqual(new Set(taken), new Set([node, edge]))
})

test('the graph being pasted into is left to the canvas: its ids do not count', async () => {
  const node = crypto.randomUUID()
  const edge = crypto.randomUUID()
  const slug = await spaceWith(node, edge)
  assert.deepEqual(await findTakenGraphIdsImpl({ ids: [node, edge], exceptAddress: slug }), [])
})
