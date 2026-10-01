// Against the real spaces registry on a throwaway database (see
// @opencroft/db's test-env): what an id resolves to is a question about the
// stored graphs, not about a fake of them.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { describeGraphRefsImpl } from './graph-refs'

async function spaceWith(nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>): Promise<string> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `graph-refs-${crypto.randomUUID()}`
  await registry.create(slug, slug, {
    nodes: nodes.map((node) => ({ ...node, position: { x: 0, y: 0 } })),
    edges: [],
  })
  return slug
}

test('a node id resolves to its type, its name and the space it lives in', async () => {
  const id = crypto.randomUUID()
  const slug = await spaceWith([{ id, type: 'builtin.core.server', data: { name: 'prod-db' } }])
  const refs = await describeGraphRefsImpl([id])
  assert.deepEqual(refs[id], { id, kind: 'node', type: 'builtin.core.server', name: 'prod-db', spaceSlug: slug })
})

test("a window node's title counts as its name; an unnamed node leaves the name to the caller", async () => {
  const titled = crypto.randomUUID()
  const unnamed = crypto.randomUUID()
  await spaceWith([
    { id: titled, type: 'builtin.core.terminal', data: { title: 'Logs' } },
    { id: unnamed, type: 'builtin.core.localhost', data: {} },
  ])
  const refs = await describeGraphRefsImpl([titled, unnamed])
  assert.equal(refs[titled]?.name, 'Logs')
  assert.equal(refs[unnamed]?.name, '')
})

test('an id that names nothing is reported as null, and repeated ids are answered once', async () => {
  const id = crypto.randomUUID()
  const refs = await describeGraphRefsImpl([id, id])
  assert.deepEqual(refs, { [id]: null })
})
