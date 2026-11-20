// Exercises the real database (embedded PGlite by default) and the real builtin.core
// extension bundle -- see @opencroft/db's test-env for how this stays off the shared
// dev/production database regardless of the ambient environment.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { listGraphHandleOwners, resolveTerminalTarget } from './host'
import { listTerminalSourcesImpl, listTerminalSourceTargetsImpl } from './terminal-sources'

const TERMINALS = { role: 'source', handleType: 'builtin.core.terminal-context' } as const

// One space holding a plain localhost (terminals known from its manifest) and a
// Terminal Router (terminals known from its data, through core's
// `dynamicHandles` entry, which is `fromData`).
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
      [routerId, false],
    ],
    'a router answers its routes from its data, so expanding it asks nothing',
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

test('a node’s handle names the graph the node is on', async () => {
  const { slug, localId } = await seedSpace()
  const registry = getSpacesRegistry()
  const ref = registry.resolveGraph(slug)
  assert.ok(ref, 'the seeded space has a default graph')
  const { createHost } = await import('./host')

  const handles = await createHost('acme.sources-ext').graph.listHandles(TERMINALS)

  const local = handles.find((handle) => handle.nodeId === localId)
  assert.deepEqual(local?.graph, { address: registry.addressOf(ref), name: ref.graph.name })
  assert.ok(local?.graph?.address.startsWith(`${slug}.`))
})

test('the picker of every space lists a source with declared terminals in full', async () => {
  const { localId } = await seedSpace()

  const sources = await listTerminalSourcesImpl()

  const local = sources.find((source) => source.ref.id === localId)
  assert.equal(local?.ref.name, 'my-machine')
  assert.deepEqual(local?.targets, [{ target: `${localId}/terminal`, handleId: 'terminal', title: 'my-machine' }])
})

test('the picker of every space lists each router in its first answer, each route naming the terminal it reaches', async () => {
  const { localId, routerId } = await seedSpace()

  const sources = await listTerminalSourcesImpl()

  const router = sources.find((source) => source.ref.id === routerId)
  assert.equal(
    router?.ref.type,
    'builtin.core.terminal-router',
    'the source carries its type, which a consumer excludes by',
  )
  assert.deepEqual(
    router?.targets?.map((target) => [target.target, target.routed?.target, target.routed?.ref?.name]),
    [[`${routerId}/route-r1`, `${localId}/terminal`, 'my-machine']],
  )
})

test('a router with no resolved route is not listed, and is still asked on its own', async () => {
  const { localId } = await seedSpace()
  const slug = `terminal-sources-${crypto.randomUUID()}`
  const routerId = `router-${crypto.randomUUID()}`
  await getSpacesRegistry().create(slug, slug, {
    nodes: [
      {
        id: routerId,
        type: 'builtin.core.terminal-router',
        position: { x: 0, y: 0 },
        // A route whose target did not resolve: no context, so no output.
        data: { routes: [{ id: 'r1', target: `${localId}/terminal` }] },
      },
    ],
    edges: [],
  })

  assert.deepEqual(await listTerminalSourcesImpl(slug), [])
  assert.deepEqual(await listTerminalSourceTargetsImpl(routerId), [])
})

test("a node's terminal handle carries the terminal's one name, the node's own for its only terminal", async () => {
  const { localId } = await seedSpace()
  const { createHost } = await import('./host')

  const handles = await createHost('acme.sources-ext').graph.listHandles(TERMINALS)

  assert.equal(handles.find((handle) => handle.nodeId === localId)?.title, 'my-machine')
})

test('the picker of one space offers its routers, each route naming the terminal it reaches', async () => {
  const { localId } = await seedSpace()
  // The App's space: only a router, whose route reaches the other space's terminal.
  const slug = `terminal-sources-${crypto.randomUUID()}`
  const routerId = `router-${crypto.randomUUID()}`
  await getSpacesRegistry().create(slug, slug, {
    nodes: [
      {
        id: routerId,
        type: 'builtin.core.terminal-router',
        position: { x: 0, y: 0 },
        data: { routes: [{ id: 'r1', target: `${localId}/terminal`, context: { type: 'local' } }] },
      },
    ],
    edges: [],
  })

  const sources = await listTerminalSourcesImpl(slug)

  assert.deepEqual(
    sources.map((source) => [source.ref.id, source.targets?.map((target) => target.target)]),
    [[routerId, [`${routerId}/route-r1`]]],
    'the space offers its router, with its routes, and not the terminal of the other space',
  )
  assert.deepEqual(await listTerminalSourceTargetsImpl(routerId), sources[0].targets, 'asked on its own, the same')
  const [route] = await listTerminalSourceTargetsImpl(routerId)
  assert.equal(route.target, `${routerId}/route-r1`)
  assert.equal(route.routed?.target, `${localId}/terminal`)
  assert.equal(route.routed?.ref?.name, 'my-machine')
  assert.equal(route.routed?.ref?.title, 'my-machine')
  // What an App given this route as its Terminal gets from terminal.getContext.
  assert.deepEqual(await resolveTerminalTarget(route.target), { type: 'local' })
})

test('one source is expanded on its own, and an unknown id has no terminals', async () => {
  const { localId } = await seedSpace()

  assert.deepEqual(await listTerminalSourceTargetsImpl(localId), [
    { target: `${localId}/terminal`, handleId: 'terminal', title: 'my-machine' },
  ])
  assert.deepEqual(await listTerminalSourceTargetsImpl(`missing-${crypto.randomUUID()}`), [])
})
