// A Key Store's SSH keys against its node, on the real database, the real graph
// documents and a cache directory of the test's own: the rows and their cache
// files go with the store's graph or space, with a deleteNodes that purges, or
// with a confirmed canvas purge, and with nothing else.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { generateSshKey } from '@opencroft/terminal/server'

import { hostAppCall } from '@/app/_authed/(apps)/_server/host-apps'
import type { GraphWriteOrigin } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { purgeKeysOf, purgeKeysWithTheirGraphs } from '@/server/key-store-removal'
import { secrets } from '@/server/secrets'
import { KEYSTORE_SECRET_ENV, keyStoresHolding, sshKeys } from '@/server/ssh-key-store'
import { purgeStoresConfirmed, storesDeletedWith } from '@/server/store-purge'

const STORE_TYPE = 'builtin.core.core-key-store'
const SECRETS_STORE_TYPE = 'builtin.core.core-secrets-store'
const SERVER_TYPE = 'builtin.core.server'
const TEST_ORIGIN: GraphWriteOrigin = { kind: 'user', name: 'alice' }
const suffix = crypto.randomUUID().slice(0, 8)

process.env[KEYSTORE_SECRET_ENV] = 'test-keystore-secret'
const cache = await mkdtemp(join(tmpdir(), 'key-store-removal-'))
process.env.OPENCROFT_CACHE_DIR = cache

after(() => rm(cache, { recursive: true, force: true }))

const registry = getSpacesRegistry()
await registry.ensureLoaded()
purgeKeysWithTheirGraphs()

let spaces = 0

/** A fresh space whose graph holds the given nodes; answers its slug and graph address. */
async function spaceWith(nodes: Record<string, unknown>[]): Promise<{ slug: string; address: string }> {
  const slug = `key-store-removal-${suffix}-${spaces++}`
  const space = await registry.create(slug, slug, { nodes, edges: [] })
  const [graph] = registry.graphsOf(space.slug)
  assert.ok(graph, `space ${slug} has its default graph`)
  return { slug: space.slug, address: `${space.slug}.${graph.slug}` }
}

function storeNode(id: string): Record<string, unknown> {
  return { id, type: STORE_TYPE, position: { x: 0, y: 0 }, data: { keyNames: [] } }
}

/** A Server whose key is `<storeId>:<name>`. */
function serverNode(id: string, name: string, keyRef: string): Record<string, unknown> {
  return { id, type: SERVER_TYPE, position: { x: 0, y: 0 }, data: { name, address: 'host.invalid', keyPath: keyRef } }
}

async function holdKey(storeId: string, name: string): Promise<void> {
  assert.equal(await sshKeys.put(storeId, name, generateSshKey('ed25519', name), 'create'), true)
}

async function keyNames(storeId: string): Promise<string[]> {
  return (await keyStoresHolding([storeId]))[0]?.keys ?? []
}

/** A key's cache file, where a build without the database keeps it; a start copies it into the database. */
async function plantCacheFile(storeId: string, name: string): Promise<string> {
  const dir = join(cache, 'extensions', 'builtin.core', 'key-store', storeId)
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  await writeFile(file, '-----BEGIN OPENSSH PRIVATE KEY-----\nA')
  return file
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  )
}

function dataOf(address: string, nodeId: string): Promise<Record<string, unknown> | undefined> {
  return mutateLiveGraph(
    address,
    TEST_ORIGIN,
    (graph) => (graph.nodes as { id: string; data?: Record<string, unknown> }[]).find((n) => n.id === nodeId)?.data,
    { resolveContexts: false },
  )
}

async function deleteNodes(address: string, params: Record<string, unknown>): Promise<string> {
  const call = await hostAppCall(address, 'deleteNodes')
  assert.ok(call, `${address} resolves as a graph app`)
  // The graph actions read only the instance id off their context.
  const ctx = { instanceId: call.instanceId } as Parameters<typeof call.action.run>[0]
  return String(await call.action.run(ctx, params))
}

type Refusal = { code?: number; message?: string }

// ── with the graph ───────────────────────────────────────────────────

test('deleting a space deletes the keys and cache files of the stores on its graph and of no other store', async () => {
  const goneId = `store-space-gone-${suffix}`
  const keptId = `store-space-kept-${suffix}`
  const gone = await spaceWith([storeNode(goneId)])
  await spaceWith([storeNode(keptId)])
  await holdKey(goneId, 'deploy')
  await holdKey(keptId, 'deploy')
  const goneFile = await plantCacheFile(goneId, 'deploy')
  const keptFile = await plantCacheFile(keptId, 'deploy')

  assert.equal(await registry.remove(gone.slug), true)
  // The purge runs behind the removal; wait on it rather than on a clock.
  for (let i = 0; i < 400 && (await keyNames(goneId)).length > 0; i++) {
    // biome-ignore lint/plugin/noTestFixedTime: poll interval of a loop capped at a fixed number of tries
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  assert.deepEqual(await keyNames(goneId), [])
  assert.equal(await exists(goneFile), false)
  assert.deepEqual(await keyNames(keptId), ['deploy'])
  assert.equal(await exists(keptFile), true)
})

test('a purge leaves the keys and cache files of nodes it was not given', async () => {
  const id = `store-untouched-${suffix}`
  await holdKey(id, 'deploy')
  const file = await plantCacheFile(id, 'deploy')

  await purgeKeysOf([`some-other-node-${suffix}`])

  assert.deepEqual(await keyNames(id), ['deploy'])
  assert.equal(await exists(file), true)
})

// ── deleteNodes ──────────────────────────────────────────────────────

test('deleteNodes refuses a store holding keys without purgeKeys, and keeps the node and its keys', async () => {
  const id = `store-refuse-${suffix}`
  const { address } = await spaceWith([storeNode(id)])
  await holdKey(id, 'deploy')

  await assert.rejects(deleteNodes(address, { nodeIds: [id] }), (refusal: Refusal) => {
    assert.equal(refusal.code, -32602)
    assert.match(refusal.message ?? '', new RegExp(`Key Stores holding SSH keys: ${id} \\(1\\).*purgeKeys: true`))
    return true
  })

  assert.ok(await dataOf(address, id), 'the node is still on the graph')
  assert.deepEqual(await keyNames(id), ['deploy'])
})

test('deleteNodes with purgeKeys deletes the store, its keys and their cache files', async () => {
  const id = `store-purge-${suffix}`
  const { address } = await spaceWith([storeNode(id)])
  await holdKey(id, 'deploy')
  await holdKey(id, 'ci')
  const file = await plantCacheFile(id, 'deploy')

  const result = JSON.parse(await deleteNodes(address, { nodeIds: [id], purgeKeys: true }))

  assert.deepEqual(result.deleted, [id])
  assert.equal(result.purgedKeys, 2)
  assert.equal(await dataOf(address, id), undefined)
  assert.deepEqual(await keyNames(id), [])
  assert.equal(await exists(file), false)
})

test('deleteNodes refuses to purge a store whose key a Server it keeps still uses, naming the Server', async () => {
  const id = `store-named-${suffix}`
  const serverId = `server-named-${suffix}`
  const { address } = await spaceWith([storeNode(id), serverNode(serverId, 'web', `${id}:deploy`)])
  await holdKey(id, 'deploy')

  await assert.rejects(deleteNodes(address, { nodeIds: [id], purgeKeys: true }), (refusal: Refusal) => {
    assert.equal(refusal.code, -32602)
    assert.match(refusal.message ?? '', new RegExp(`key deploy: web \\(${serverId}\\).*allowUnclean: true`))
    return true
  })
  assert.ok(await dataOf(address, id), 'the node is still on the graph')
  assert.deepEqual(await keyNames(id), ['deploy'])

  const result = JSON.parse(await deleteNodes(address, { nodeIds: [id], purgeKeys: true, allowUnclean: true }))
  assert.deepEqual(result.deleted, [id])
  assert.deepEqual(await keyNames(id), [])
})

test('deleteNodes refuses to purge a store whose key a routed copy on another graph uses', async () => {
  const id = `store-routed-${suffix}`
  const serverId = `server-routed-${suffix}`
  const copyId = `copy-routed-${suffix}`
  const { address } = await spaceWith([storeNode(id), serverNode(serverId, 'web', `${id}:deploy`)])
  // A terminal context copied onto another graph keeps the Server it came from as its scope.
  await spaceWith([
    {
      id: copyId,
      type: 'builtin.core.terminal-router',
      position: { x: 0, y: 0 },
      data: { name: 'router', routes: [{ credentialsScope: serverId, keyPath: `${id}:deploy` }] },
    },
  ])
  await holdKey(id, 'deploy')

  await assert.rejects(deleteNodes(address, { nodeIds: [id], purgeKeys: true }), (refusal: Refusal) => {
    assert.match(
      refusal.message ?? '',
      new RegExp(
        `key deploy: (web \\(${serverId}\\), router \\(${copyId}\\)|router \\(${copyId}\\), web \\(${serverId}\\))`,
      ),
    )
    return true
  })
  assert.deepEqual(await keyNames(id), ['deploy'])
})

test('deleteNodes purges a store when the only Server using its key is deleted with it', async () => {
  const id = `store-named-together-${suffix}`
  const serverId = `server-named-together-${suffix}`
  const { address } = await spaceWith([storeNode(id), serverNode(serverId, 'web', `${id}:deploy`)])
  await holdKey(id, 'deploy')

  const result = JSON.parse(await deleteNodes(address, { nodeIds: [id, serverId], purgeKeys: true }))
  assert.deepEqual(result.deleted, [id, serverId])
  assert.deepEqual(await keyNames(id), [])
})

test('deleteNodes deletes an empty Key Store without purgeKeys', async () => {
  const id = `store-empty-${suffix}`
  const { address } = await spaceWith([storeNode(id)])
  const result = JSON.parse(await deleteNodes(address, { nodeIds: [id] }))
  assert.deepEqual(result.deleted, [id])
  assert.equal(result.purgedKeys, undefined)
})

test('deleteNodes asks for both flags when a Secrets Store and a Key Store hold something', async () => {
  const keyStoreId = `store-both-keys-${suffix}`
  const secretStoreId = `store-both-secrets-${suffix}`
  const { address } = await spaceWith([
    storeNode(keyStoreId),
    { id: secretStoreId, type: SECRETS_STORE_TYPE, position: { x: 0, y: 0 }, data: { secretKeys: [] } },
  ])
  await holdKey(keyStoreId, 'deploy')
  await secrets.set(secretStoreId, 'TOKEN', 'v')

  await assert.rejects(
    deleteNodes(address, { nodeIds: [keyStoreId, secretStoreId], purgeSecrets: true }),
    (refusal: Refusal) => {
      assert.match(refusal.message ?? '', /Key Stores holding SSH keys/)
      assert.doesNotMatch(refusal.message ?? '', /Secrets Stores holding/)
      return true
    },
  )
  assert.deepEqual(await secrets.listKeys(secretStoreId), ['TOKEN'])

  const result = JSON.parse(
    await deleteNodes(address, { nodeIds: [keyStoreId, secretStoreId], purgeSecrets: true, purgeKeys: true }),
  )
  assert.equal(result.purgedSecrets, 1)
  assert.equal(result.purgedKeys, 1)
  assert.deepEqual(await keyNames(keyStoreId), [])
  assert.deepEqual(await secrets.listKeys(secretStoreId), [])
})

// ── the canvas's confirmed purge ─────────────────────────────────────

test('the canvas confirm lists the Key Stores being deleted and the Servers that use their keys', async () => {
  const id = `store-listed-${suffix}`
  const serverId = `server-listed-${suffix}`
  await spaceWith([storeNode(id), serverNode(serverId, 'web', `${id}:deploy`)])
  await holdKey(id, 'deploy')
  await holdKey(id, 'spare')

  const deleted = await storesDeletedWith([id])

  assert.deepEqual(deleted.secretStores, [])
  assert.deepEqual(deleted.keyStores, [{ storeId: id, keys: ['deploy', 'spare'] }])
  assert.deepEqual(deleted.named.keys, [
    { key: 'deploy', references: [{ nodeId: serverId, nodeType: SERVER_TYPE, nodeName: 'web' }] },
  ])
})

test('a confirmed purge deletes the Key Store’s keys when every Server using them was listed', async () => {
  const id = `store-confirmed-${suffix}`
  const serverId = `server-confirmed-${suffix}`
  await spaceWith([storeNode(id), serverNode(serverId, 'web', `${id}:deploy`)])
  await holdKey(id, 'deploy')
  const file = await plantCacheFile(id, 'deploy')

  assert.deepEqual(await purgeStoresConfirmed([id], [serverId]), { purged: true })
  assert.deepEqual(await keyNames(id), [])
  assert.equal(await exists(file), false)
})

test('a Server the confirm did not list refuses the whole purge, secrets included', async () => {
  const keyStoreId = `store-unseen-keys-${suffix}`
  const secretStoreId = `store-unseen-secrets-${suffix}`
  const serverId = `server-unseen-${suffix}`
  // `web` started using the key while the confirm, which listed nobody, was open.
  await spaceWith([
    storeNode(keyStoreId),
    { id: secretStoreId, type: SECRETS_STORE_TYPE, position: { x: 0, y: 0 }, data: { secretKeys: [] } },
    serverNode(serverId, 'web', `${keyStoreId}:deploy`),
  ])
  await holdKey(keyStoreId, 'deploy')
  await secrets.set(secretStoreId, 'TOKEN', 'v')

  const outcome = await purgeStoresConfirmed([keyStoreId, secretStoreId], [])

  assert.ok('refused' in outcome)
  assert.deepEqual(outcome.refused.secrets, [])
  assert.deepEqual(
    outcome.refused.keys.map(({ key, references }) => [key, references.map((ref) => ref.nodeId)]),
    [['deploy', [serverId]]],
  )
  assert.deepEqual(await keyNames(keyStoreId), ['deploy'])
  assert.deepEqual(await secrets.listKeys(secretStoreId), ['TOKEN'])
})
