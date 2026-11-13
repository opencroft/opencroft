// Exercises the real spaces registry (embedded PGlite): the rule is about which graph holds a node,
// which only the registry answers.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { requireKeyStoreOnGraphOf } from './key-store-scope'

const KEY_STORE_TYPE = 'builtin.core.core-key-store'
let spaces = 0

/** A fresh space whose default graph holds a Key Store, a Server and a Secrets Store. Answers their ids and the graph's address. */
async function graphWithKeyStore() {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `key-scope-${crypto.randomUUID().slice(0, 8)}-${spaces++}`
  const ids = { storeId: `store-${slug}`, serverId: `server-${slug}`, secretsId: `secrets-${slug}` }
  const space = await registry.create(slug, slug, {
    nodes: [
      { id: ids.storeId, type: KEY_STORE_TYPE, position: { x: 0, y: 0 }, data: {} },
      { id: ids.serverId, type: 'builtin.core.server', position: { x: 200, y: 0 }, data: {} },
      { id: ids.secretsId, type: 'builtin.core.core-secrets-store', position: { x: 400, y: 0 }, data: {} },
    ],
    edges: [],
  })
  const [graph] = registry.graphsOf(space.slug)
  return { ...ids, address: `${space.slug}.${graph.slug}` }
}

test('a Key Store on the node’s own graph is admitted', async () => {
  const home = await graphWithKeyStore()

  await requireKeyStoreOnGraphOf(home.storeId, home.serverId)
})

test('a Key Store on another graph is refused, naming the store and the node’s graph', async () => {
  const home = await graphWithKeyStore()
  const other = await graphWithKeyStore()

  await assert.rejects(
    () => requireKeyStoreOnGraphOf(other.storeId, home.serverId),
    (err: Error) =>
      err.message ===
      `No Key Store ${other.storeId} on graph ${home.address}: a key is used only from a Key Store on the graph of the node that names it`,
  )
  await requireKeyStoreOnGraphOf(other.storeId, other.serverId)
})

test('a node on the graph that is not a Key Store is refused as a store', async () => {
  const home = await graphWithKeyStore()

  await assert.rejects(() => requireKeyStoreOnGraphOf(home.secretsId, home.serverId), /No Key Store secrets-/)
  await assert.rejects(() => requireKeyStoreOnGraphOf(home.serverId, home.serverId), /No Key Store server-/)
})

test('without a node, or for a node on no graph, no store is admitted', async () => {
  const home = await graphWithKeyStore()

  await assert.rejects(() => requireKeyStoreOnGraphOf(home.storeId, undefined), /no node was given/)
  await assert.rejects(() => requireKeyStoreOnGraphOf(home.storeId, ''), /no node was given/)
  await assert.rejects(
    () => requireKeyStoreOnGraphOf(home.storeId, `missing-${home.serverId}`),
    /is on no graph, so no Key Store's key can be used for it/,
  )
})
