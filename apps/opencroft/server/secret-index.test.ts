// A Secrets Store node's key index against the rows it indexes, on the real
// database and the real graph documents: every write path, every graph change
// and the boot pass keep it exact, racing writes and a racing graph save cannot
// leave it short, and a store's rows go only with an explicit purge or with its
// graph.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { hostAppCall } from '@/app/_authed/(apps)/_server/host-apps'
import type { GraphWriteOrigin } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { exactIndex, indexSecretStores, reconcileSecretIndexes } from '@/server/secret-index'
import { purgeSecretsOf, purgeSecretsWithTheirGraphs } from '@/server/secret-store-removal'
import { secrets } from '@/server/secrets'
import { purgeStoresConfirmed } from '@/server/store-purge'

const STORE_TYPE = 'builtin.core.core-secrets-store'
const TEST_ORIGIN: GraphWriteOrigin = { kind: 'user', name: 'alice' }
const suffix = crypto.randomUUID().slice(0, 8)

const registry = getSpacesRegistry()
await registry.ensureLoaded()
indexSecretStores()
purgeSecretsWithTheirGraphs()

let spaces = 0

/** A fresh space whose graph holds the given nodes; answers its slug and graph address. */
async function spaceWith(nodes: Record<string, unknown>[]): Promise<{ slug: string; address: string }> {
  const slug = `secret-index-${suffix}-${spaces++}`
  const space = await registry.create(slug, slug, { nodes, edges: [] })
  const [graph] = registry.graphsOf(space.slug)
  assert.ok(graph, `space ${slug} has its default graph`)
  return { slug: space.slug, address: `${space.slug}.${graph.slug}` }
}

function storeNode(id: string, data: Record<string, unknown> = { secretKeys: [] }): Record<string, unknown> {
  return { id, type: STORE_TYPE, position: { x: 0, y: 0 }, data }
}

/** The node's data as its graph's document holds it now. */
function dataOf(address: string, nodeId: string): Promise<Record<string, unknown> | undefined> {
  return mutateLiveGraph(
    address,
    TEST_ORIGIN,
    (graph) => (graph.nodes as { id: string; data?: Record<string, unknown> }[]).find((n) => n.id === nodeId)?.data,
    { resolveContexts: false },
  )
}

async function indexOf(address: string, nodeId: string): Promise<unknown> {
  return (await dataOf(address, nodeId))?.secretKeys
}

/** Writes the stored index directly, bypassing the re-derivation, so a test can start from any list. */
function setStoredIndex(address: string, nodeId: string, list: string[]): Promise<void> {
  return mutateLiveGraph(
    address,
    TEST_ORIGIN,
    (graph) => {
      const node = (graph.nodes as { id: string; data?: Record<string, unknown> }[]).find((n) => n.id === nodeId)
      assert.ok(node)
      node.data = { ...node.data, secretKeys: list }
    },
    { resolveContexts: false },
  )
}

/** The index as the registry holds it now, read without writing the graph. */
function heldIndex(address: string, nodeId: string): unknown {
  const ref = registry.resolveGraph(address)
  assert.ok(ref, `${address} resolves`)
  const node = (ref.graph.graph.nodes as { id: string; data?: Record<string, unknown> }[]).find((n) => n.id === nodeId)
  return node?.data?.secretKeys
}

/** Waits until the held index equals `expected`, or a bound passes; answers the index it ends with. */
async function settledIndex(address: string, nodeId: string, expected: string[]): Promise<unknown> {
  for (let i = 0; i < 400; i++) {
    const index = heldIndex(address, nodeId)
    if (Array.isArray(index) && index.length === expected.length && index.every((name, n) => name === expected[n])) {
      return index
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return heldIndex(address, nodeId)
}

// ── the rule ─────────────────────────────────────────────────────────

test('the exact rule answers the store’s names, and nothing when the index already matches', () => {
  assert.deepEqual(exactIndex(['A'], ['A', 'B']), ['A', 'B'])
  assert.deepEqual(exactIndex(['A', 'GONE'], ['A']), ['A'])
  assert.deepEqual(exactIndex(['B', 'A'], ['A', 'B']), ['A', 'B'], 'the store’s order')
  assert.equal(exactIndex(['A', 'B'], ['A', 'B']), null)
})

// ── every write path keeps the index exact ──────────────────────────

test('a set, a rotation, a delete and a delete by id each leave the index equal to the store', async () => {
  const id = `store-paths-${suffix}`
  const { address } = await spaceWith([storeNode(id)])

  await secrets.set(id, 'FIRST', 'one')
  await secrets.set(id, 'SECOND', 'two')
  assert.deepEqual(await indexOf(address, id), ['FIRST', 'SECOND'], 'set adds')

  await secrets.set(id, 'FIRST', 'one-rotated')
  assert.deepEqual(await indexOf(address, id), ['FIRST', 'SECOND'], 'a rotation changes no name')

  await secrets.delete(id, 'FIRST')
  assert.deepEqual(await indexOf(address, id), ['SECOND'], 'delete removes')

  const [row] = await secrets.list(id)
  assert.ok(row)
  await secrets.deleteById(row.id)
  assert.deepEqual(await indexOf(address, id), [], 'delete by id removes')

  await secrets.set(id, 'THIRD', 'three')
  await secrets.deleteStore(id)
  assert.deepEqual(await indexOf(address, id), [], 'deleting the whole store empties it')
})

test('a store node created without data takes an index from its first write', async () => {
  const id = `store-bare-${suffix}`
  const { address } = await spaceWith([{ id, type: STORE_TYPE, position: { x: 0, y: 0 } }])
  await secrets.set(id, 'KEY', 'value')
  assert.deepEqual(await indexOf(address, id), ['KEY'])
})

test('a node that is no Secrets Store is not given an index by rows stored under its id', async () => {
  const id = `not-a-store-${suffix}`
  const { address } = await spaceWith([{ id, type: 'acme.notes.note', position: { x: 0, y: 0 }, data: { text: 'x' } }])
  await secrets.set(id, 'KEY', 'value')
  assert.deepEqual(await dataOf(address, id), { text: 'x' })
})

// ── races ─────────────────────────────────────────────────────────────

test('writes racing each other on one store leave every name in the index', async () => {
  const id = `store-race-${suffix}`
  const { address } = await spaceWith([storeNode(id)])
  const names = Array.from({ length: 12 }, (_, i) => `KEY_${String(i).padStart(2, '0')}`)

  await Promise.all(names.map((name) => secrets.set(id, name, 'v')))

  const index = (await indexOf(address, id)) as string[]
  assert.deepEqual([...index].sort(), names)
  assert.deepEqual([...(await secrets.listKeys(id))].sort(), names, 'CONTROL: every row landed')
})

test('a re-derivation that read the store before a later write cannot leave the older list behind', async () => {
  const id = `store-stale-read-${suffix}`
  const { address } = await spaceWith([storeNode(id)])
  const listKeys = secrets.listKeys
  // The first re-derivation of this store reads the rows, then is held before
  // it writes the index. It is let go once the second write's re-derivation
  // has finished, or after a bound when that one is waiting its turn instead.
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const bound = setTimeout(release, 500)
  let firstRead = () => {}
  const firstReadDone = new Promise<void>((resolve) => {
    firstRead = resolve
  })
  let reads = 0
  secrets.listKeys = async (storeId) => {
    const names = await listKeys.call(secrets, storeId)
    if (storeId === id && reads++ === 0) {
      firstRead()
      await held
    }
    return names
  }
  secrets.onStoreChanged(async (storeId) => {
    if (storeId === id && reads > 1) {
      release()
    }
  })
  try {
    const first = secrets.set(id, 'FIRST', 'v')
    // The second write starts once the first re-derivation has read the rows.
    await firstReadDone
    await secrets.set(id, 'SECOND', 'v')
    await first
  } finally {
    clearTimeout(bound)
    secrets.listKeys = listKeys
  }

  assert.equal(reads, 2, 'CONTROL: each write re-derived the index once')
  assert.deepEqual(await indexOf(address, id), ['FIRST', 'SECOND'])
})

test('a graph save made from a copy read before a write keeps the name that write indexed', async () => {
  const id = `store-save-race-${suffix}`
  const { address } = await spaceWith([storeNode(id, { secretKeys: [], label: 'before' })])

  // The save reads the graph, then waits while a secret is written and
  // indexed, then changes another field of the same node from its stale copy.
  await mutateLiveGraph(
    address,
    TEST_ORIGIN,
    async (graph) => {
      await secrets.set(id, 'WRITTEN_MEANWHILE', 'v')
      const node = (graph.nodes as { id: string; data: Record<string, unknown> }[]).find((n) => n.id === id)
      assert.ok(node)
      assert.deepEqual(node.data.secretKeys, [], 'CONTROL: the save’s copy predates the write')
      node.data = { ...node.data, label: 'after' }
    },
    { resolveContexts: false },
  )

  const data = await dataOf(address, id)
  assert.equal(data?.label, 'after', 'the save landed')
  assert.deepEqual(data?.secretKeys, ['WRITTEN_MEANWHILE'], 'and the index written meanwhile survived it')
})

// ── a graph change ────────────────────────────────────────────────────

test('a store pasted with another store’s list, and no rows of its own, lists no name', async () => {
  const originalId = `store-original-${suffix}`
  const copyId = `store-copy-${suffix}`
  const { address } = await spaceWith([storeNode(originalId)])
  await secrets.set(originalId, 'HELD', 'v')

  // As a paste writes it: a fresh id carrying the copied node's data.
  await mutateLiveGraph(address, TEST_ORIGIN, (graph) => {
    graph.nodes.push(storeNode(copyId, { secretKeys: ['HELD'], label: 'copy' }) as (typeof graph.nodes)[number])
  })

  assert.deepEqual(await settledIndex(address, copyId, []), [])
  assert.deepEqual(heldIndex(address, originalId), ['HELD'], 'the original keeps its name')
})

test('a graph write that lists a name no row holds, and leaves out one a row holds, is brought to the store', async () => {
  const id = `store-graph-write-${suffix}`
  const { address } = await spaceWith([storeNode(id)])
  await secrets.set(id, 'REAL', 'v')

  await setStoredIndex(address, id, ['GHOST'])

  assert.deepEqual(await settledIndex(address, id, ['REAL']), ['REAL'])
})

test('a graph change leaves a store already in step unwritten', async () => {
  const id = `store-in-step-${suffix}`
  const otherId = `note-in-step-${suffix}`
  const { address } = await spaceWith([
    storeNode(id),
    { id: otherId, type: 'acme.notes.note', position: { x: 0, y: 0 }, data: { text: 'a' } },
  ])
  await secrets.set(id, 'KEY', 'v')
  const ref = registry.resolveGraph(address)
  assert.ok(ref)
  let changes = 0
  registry.onGraphChanged((changed) => {
    if (changed.graph.id === ref.graph.id) {
      changes++
    }
  })

  await mutateLiveGraph(address, TEST_ORIGIN, (graph) => {
    const note = (graph.nodes as { id: string; data?: Record<string, unknown> }[]).find((n) => n.id === otherId)
    assert.ok(note)
    note.data = { text: 'b' }
  })
  // Past the check that change schedules.
  await new Promise((resolve) => setTimeout(resolve, 600))

  assert.equal(changes, 1, 'only the edit itself changed the graph')
  assert.deepEqual(heldIndex(address, id), ['KEY'])
})

// ── the boot pass ─────────────────────────────────────────────────────

test('the boot pass brings a stored index to the store: drops names without a row, adds missing ones, in store order', async () => {
  const id = `store-boot-${suffix}`
  // Rows written before the graph holds the node, so no write re-derives its index.
  await secrets.set(id, 'A', 'v')
  await secrets.set(id, 'B', 'v')
  const { address } = await spaceWith([storeNode(id, { secretKeys: ['LISTED_ONLY', 'B'] })])
  assert.deepEqual(heldIndex(address, id), ['LISTED_ONLY', 'B'], 'CONTROL: the stored index is stale')

  const repaired = await reconcileSecretIndexes()

  assert.ok(repaired >= 1, `repaired ${repaired}`)
  assert.deepEqual(heldIndex(address, id), ['A', 'B'])
  assert.equal(await reconcileSecretIndexes(), 0, 'a second run changes nothing')
})

// ── deleting a store ──────────────────────────────────────────────────

async function deleteNodes(address: string, params: Record<string, unknown>): Promise<string> {
  const call = await hostAppCall(address, 'deleteNodes')
  assert.ok(call, `${address} resolves as a graph app`)
  // The graph actions read only the instance id off their context.
  const ctx = { instanceId: call.instanceId } as Parameters<typeof call.action.run>[0]
  return String(await call.action.run(ctx, params))
}

test('deleteNodes refuses a store holding secrets without purgeSecrets, and keeps the node and its rows', async () => {
  const id = `store-refuse-${suffix}`
  const { address } = await spaceWith([storeNode(id)])
  await secrets.set(id, 'KEEP', 'v')

  await assert.rejects(deleteNodes(address, { nodeIds: [id] }), (refusal: { code?: number; message?: string }) => {
    assert.equal(refusal.code, -32602)
    assert.match(refusal.message ?? '', new RegExp(`${id} \\(1\\).*purgeSecrets: true`))
    return true
  })

  assert.ok(await dataOf(address, id), 'the node is still on the graph')
  assert.deepEqual(await secrets.listKeys(id), ['KEEP'])
})

test('deleteNodes with purgeSecrets deletes the store and its rows', async () => {
  const id = `store-purge-${suffix}`
  const { address } = await spaceWith([storeNode(id)])
  await secrets.set(id, 'GOES', 'v')

  const result = JSON.parse(await deleteNodes(address, { nodeIds: [id], purgeSecrets: true }))

  assert.deepEqual(result.deleted, [id])
  assert.equal(result.purgedSecrets, 1)
  assert.equal(await dataOf(address, id), undefined)
  assert.deepEqual(await secrets.listKeys(id), [])
})

test('deleteNodes refuses to purge a store whose secret a node it keeps still names, naming the node', async () => {
  const id = `store-named-${suffix}`
  const userId = `user-named-${suffix}`
  const { address } = await spaceWith([
    storeNode(id),
    { id: userId, type: 'builtin.core.script', position: { x: 0, y: 0 }, data: { name: 'worker', secrets: 'NAMED' } },
  ])
  await secrets.set(id, 'NAMED', 'v')

  await assert.rejects(
    deleteNodes(address, { nodeIds: [id], purgeSecrets: true }),
    (refusal: { code?: number; message?: string }) => {
      assert.equal(refusal.code, -32602)
      assert.match(refusal.message ?? '', new RegExp(`NAMED: worker \\(${userId}\\).*allowUnclean: true`))
      return true
    },
  )
  assert.ok(await dataOf(address, id), 'the node is still on the graph')
  assert.deepEqual(await secrets.listKeys(id), ['NAMED'])

  const result = JSON.parse(await deleteNodes(address, { nodeIds: [id], purgeSecrets: true, allowUnclean: true }))
  assert.deepEqual(result.deleted, [id])
  assert.deepEqual(await secrets.listKeys(id), [])
})

test('deleteNodes purges a store when the only node naming its secret is deleted with it', async () => {
  const id = `store-named-together-${suffix}`
  const userId = `user-named-together-${suffix}`
  const { address } = await spaceWith([
    storeNode(id),
    { id: userId, type: 'builtin.core.script', position: { x: 0, y: 0 }, data: { secrets: 'TOGETHER' } },
  ])
  await secrets.set(id, 'TOGETHER', 'v')

  const result = JSON.parse(await deleteNodes(address, { nodeIds: [id, userId], purgeSecrets: true }))
  assert.deepEqual(result.deleted, [id, userId])
  assert.deepEqual(await secrets.listKeys(id), [])
})

// The canvas's confirmed purge: past exactly the nodes its confirm listed.

function namingNode(id: string, name: string, secretNames: string): Record<string, unknown> {
  return { id, type: 'builtin.core.script', position: { x: 0, y: 0 }, data: { name, secrets: secretNames } }
}

test('a confirmed purge deletes the store when every node naming its secrets was listed', async () => {
  const id = `store-confirmed-${suffix}`
  const listedId = `user-confirmed-${suffix}`
  await spaceWith([storeNode(id), namingNode(listedId, 'worker', 'SHOWN')])
  await secrets.set(id, 'SHOWN', 'v')

  assert.deepEqual(await purgeStoresConfirmed([id], [listedId]), { purged: true })
  assert.deepEqual(await secrets.listKeys(id), [])
})

test('a node the confirm did not list refuses the purge, which deletes nothing and lists every node naming a secret', async () => {
  const id = `store-unseen-${suffix}`
  const listedId = `user-listed-${suffix}`
  const unseenId = `user-unseen-${suffix}`
  // `late-worker` started naming OTHER while the confirm, listing only `worker`, was open.
  await spaceWith([
    storeNode(id),
    namingNode(listedId, 'worker', 'SHOWN'),
    namingNode(unseenId, 'late-worker', 'OTHER'),
  ])
  await secrets.set(id, 'SHOWN', 'v')
  await secrets.set(id, 'OTHER', 'v')

  const outcome = await purgeStoresConfirmed([id], [listedId])

  assert.ok('refused' in outcome)
  assert.deepEqual(outcome.refused.keys, [])
  assert.deepEqual(
    outcome.refused.secrets.map(({ key, references }) => [key, references.map((ref) => ref.nodeId)]),
    [
      ['SHOWN', [listedId]],
      ['OTHER', [unseenId]],
    ],
  )
  assert.deepEqual(await secrets.listKeys(id), ['SHOWN', 'OTHER'])
})

test('a node deleted with the store does not hold a confirmed purge back', async () => {
  const id = `store-confirmed-together-${suffix}`
  const userId = `user-confirmed-together-${suffix}`
  await spaceWith([storeNode(id), namingNode(userId, 'worker', 'TOGETHER')])
  await secrets.set(id, 'TOGETHER', 'v')

  assert.deepEqual(await purgeStoresConfirmed([id, userId], []), { purged: true })
  assert.deepEqual(await secrets.listKeys(id), [])
})

test('deleteNodes deletes an empty store without purgeSecrets', async () => {
  const id = `store-empty-${suffix}`
  const { address } = await spaceWith([storeNode(id)])
  const result = JSON.parse(await deleteNodes(address, { nodeIds: [id] }))
  assert.deepEqual(result.deleted, [id])
  assert.equal(result.purgedSecrets, undefined)
})

test('deleting a space deletes the rows of the stores on its graph and of no other store', async () => {
  const goneId = `store-space-gone-${suffix}`
  const keptId = `store-space-kept-${suffix}`
  const gone = await spaceWith([storeNode(goneId)])
  await spaceWith([storeNode(keptId)])
  await secrets.set(goneId, 'GOES', 'v')
  await secrets.set(keptId, 'STAYS', 'v')

  assert.equal(await registry.remove(gone.slug), true)
  // The purge runs behind the removal; wait on it rather than on a clock.
  for (let i = 0; i < 400 && (await secrets.listKeys(goneId)).length > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  assert.deepEqual(await secrets.listKeys(goneId), [])
  assert.deepEqual(await secrets.listKeys(keptId), ['STAYS'])
})

test('a purge leaves the rows of nodes it was not given', async () => {
  const id = `store-untouched-${suffix}`
  await secrets.set(id, 'STAYS', 'v')
  await purgeSecretsOf([`some-other-node-${suffix}`])
  assert.deepEqual(await secrets.listKeys(id), ['STAYS'])
})
