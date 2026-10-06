// Exercises the real database (embedded PGlite by default) and the real builtin.core
// extension bundle -- see @opencroft/db's test-env for how this stays off the shared
// dev/production database regardless of the ambient environment.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { listGraphHandleOwners } from './host'
import { listTerminalSourcesImpl, listTerminalSourceTargetsImpl } from './terminal-sources'

const TERMINALS = { role: 'source', handleType: 'builtin.core.terminal-context' } as const

// One space holding a plain localhost (terminals known from its manifest) and a
// Terminal Router (terminals known only by expanding it, like a docker host,
// but without a network behind it).
async function seedSpace() {
  const slug = `terminal-sources-${crypto.randomUUID()}`
  const localId = `local-${crypto.randomUUID()}`
  const routerId = `router-${crypto.randomUUID()}`
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  await registry.create(slug, slug, {
    nodes: [
      { id: localId, type: 'builtin.core.localhost', position: { x: 0, y: 0 }, data: { name: 'my-machine' } },
      {
        id: routerId,
        type: 'builtin.core.terminal-router',
        position: { x: 0, y: 0 },
        data: { routes: [{ id: 'r1', target: `${localId}/terminal`, context: { type: 'local' } }] },
      },
    ],
    edges: [],
  })
  return { slug, localId, routerId }
}

test('handle owners are listed before any is expanded, each saying whether expanding asks anything', async () => {
  const { slug, localId, routerId } = await seedSpace()

  const owners = await listGraphHandleOwners(TERMINALS, { spaceSlug: slug })

  assert.deepEqual(
    owners.map((owner) => [owner.id, owner.dynamic]),
    [
      [localId, false],
      [routerId, true],
    ],
  )
  const router = owners.find((owner) => owner.id === routerId)
  assert.deepEqual(
    (await router?.handles())?.map((handle) => handle.handleId),
    ['route-r1'],
  )
})

test('an owner scope narrows to one space or one owner', async () => {
  const { slug, localId } = await seedSpace()
  const other = await seedSpace()

  const inSpace = await listGraphHandleOwners(TERMINALS, { spaceSlug: slug })
  assert.ok(inSpace.every((owner) => owner.spaceSlug === slug))
  assert.ok(!inSpace.some((owner) => owner.id === other.localId))

  const one = await listGraphHandleOwners(TERMINALS, { ownerId: localId })
  assert.deepEqual(
    one.map((owner) => owner.id),
    [localId],
  )
})

test('listHandles still returns every owner’s handles, expanded', async () => {
  const { localId, routerId } = await seedSpace()
  const { createHost } = await import('./host')

  const handles = await createHost('acme.sources-ext').graph.listHandles(TERMINALS)

  assert.ok(handles.some((handle) => handle.nodeId === localId && handle.handleId === 'terminal'))
  assert.ok(handles.some((handle) => handle.nodeId === routerId && handle.handleId === 'route-r1'))
})

test('the picker lists a source with declared terminals in full, and leaves routers out', async () => {
  const { slug, localId, routerId } = await seedSpace()

  const sources = await listTerminalSourcesImpl(slug)

  assert.deepEqual(
    sources.map((source) => source.ref.id),
    [localId],
  )
  assert.equal(sources[0].ref.name, 'my-machine')
  assert.deepEqual(sources[0].targets, [{ target: `${localId}/terminal`, handleId: 'terminal', label: undefined }])
  assert.deepEqual(await listTerminalSourceTargetsImpl(routerId), [])
})

test('one source is expanded on its own, and an unknown id has no terminals', async () => {
  const { localId } = await seedSpace()

  assert.deepEqual(await listTerminalSourceTargetsImpl(localId), [
    { target: `${localId}/terminal`, handleId: 'terminal', label: undefined },
  ])
  assert.deepEqual(await listTerminalSourceTargetsImpl(`missing-${crypto.randomUUID()}`), [])
})
