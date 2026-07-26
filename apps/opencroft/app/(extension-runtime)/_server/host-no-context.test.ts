// Exercises the real database (embedded PGlite by default) and the real builtin/core
// extension bundle. Run with an isolated PGLITE_PATH so this doesn't touch the shared
// dev database, e.g.:
//   PGLITE_PATH=$(mktemp -d) node_modules/.bin/tsx --test app/\(extension-runtime\)/_server/host-no-context.test.ts
//
// The point of this file: host.storage, host.terminal.getContext and
// host.graph.listHandles must work when called from code with NO TanStack Start
// request context at all — that's the situation an extension's Nitro HTTP route
// handler is in. Deliberately does NOT wrap anything in a request/middleware context,
// unlike how these functions are normally reached from an extension action (a real
// createFileRoute call, which does establish that context).
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/(space)/_server/store'
import { createHost } from './host'

test('host.storage get/set/list/delete/clear work with no Start context at all', async () => {
  const host = createHost(`host-no-context-storage-${crypto.randomUUID()}`)

  assert.equal(await host.storage.get('key'), null)

  await host.storage.set('key', { value: 42 })
  assert.deepEqual(await host.storage.get('key'), { value: 42 })
  assert.deepEqual(await host.storage.list(), ['key'])

  await host.storage.delete('key')
  assert.equal(await host.storage.get('key'), null)

  await host.storage.set('a', 1)
  await host.storage.set('b', 2)
  await host.storage.clear()
  assert.deepEqual(await host.storage.list(), [])
})

test('host.terminal.getContext resolves a node output with no Start context at all', async () => {
  const slug = `host-no-context-terminal-${crypto.randomUUID()}`
  const nodeId = 'localhost-1'
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  await registry.create(slug, slug, {
    nodes: [{ id: nodeId, type: 'localhost', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
  })

  const host = createHost('host-no-context-terminal-ext')
  const ctx = await host.terminal.getContext(nodeId, 'terminal')
  assert.deepEqual(ctx, { type: 'local' })
})

test('host.graph.listHandles enumerates with no Start context, and its ids resolve', async () => {
  // Covers the enumeration path — spaces, manifests, filtering, and the
  // getContext pairing — with no Start context. It does NOT cover the dynamic
  // expansion branch: a localhost node returns before the docker call, and
  // reaching that branch needs an application node with a live docker context.
  // The static guard below is what holds that half.
  const slug = `host-no-context-handles-${crypto.randomUUID()}`
  const nodeId = 'localhost-handles-1'
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  await registry.create(slug, slug, {
    nodes: [{ id: nodeId, type: 'localhost', position: { x: 0, y: 0 }, data: { name: 'my-machine' } }],
    edges: [],
  })

  const host = createHost('host-no-context-handles-ext')
  const handles = await host.graph.listHandles({ role: 'source', contextType: 'terminal-context' })

  const mine = handles.filter((handle) => handle.nodeId === nodeId)
  assert.ok(mine.length > 0, 'the localhost node must expose at least one terminal source')
  assert.equal(mine[0].spaceSlug, slug, 'the space is reported rather than flattened away')
  assert.equal(mine[0].nodeName, 'my-machine')
  assert.equal(mine[0].role, 'source')
  assert.equal(mine[0].contextType, 'terminal-context')

  // The pairing that makes the API useful: every id it hands back is one
  // getContext can actually resolve.
  for (const handle of mine) {
    assert.ok(await host.terminal.getContext(handle.nodeId, handle.handleId))
  }

  // Filters are honoured rather than ignored.
  const targets = await host.graph.listHandles({ role: 'target' })
  assert.ok(
    targets.every((handle) => handle.role === 'target'),
    'a role filter must not leak the other role',
  )
})

test('node-handles reaches extension actions through the plain impl, never the server fn', async () => {
  // Asserted against the source rather than by execution, deliberately: the
  // failing path needs an application node with a live docker context, so an
  // executed test would pass whether or not the dependency is correct — and a
  // vacuous guard is worse than none.
  //
  // The rule: the createServerFn in _server/actions.ts needs TanStack Start's
  // request-scoped AsyncLocalStorage. host.graph.listHandles is reachable from
  // an extension's Nitro route, which never establishes it, so this module must
  // use invokeExtensionActionImpl. Using the server fn would throw only for
  // nodes that have something to expand — surfacing as "some sources are
  // missing" rather than as an error.
  const source = await readFile(new URL('./node-handles.ts', import.meta.url), 'utf8')
  assert.ok(
    !/from '@\/app\/\(extension-runtime\)\/_server\/actions'/.test(source),
    'node-handles.ts must not import from _server/actions (server fns need a Start context)',
  )
  assert.match(source, /invokeExtensionActionImpl/)
})
