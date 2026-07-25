// Exercises the real database (embedded PGlite by default) and the real builtin/core
// extension bundle. Run with an isolated PGLITE_PATH so this doesn't touch the shared
// dev database, e.g.:
//   PGLITE_PATH=$(mktemp -d) node_modules/.bin/tsx --test app/\(extension-runtime\)/_server/host-no-context.test.ts
//
// The point of this file: host.storage and host.terminal.getContext must work when
// called from code with NO TanStack Start request context at all — that's the
// situation an extension's Nitro HTTP route handler is in. Deliberately does NOT wrap
// anything in a request/middleware context, unlike how these functions are normally
// reached from an extension action (a real createFileRoute call, which does establish
// that context).
import assert from 'node:assert/strict'
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
