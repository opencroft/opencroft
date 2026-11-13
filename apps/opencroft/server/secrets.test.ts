// Exercises the real database (embedded PGlite) — no mocking, so an encrypt/decrypt
// mismatch or a broken upsert target shows up here rather than only in production.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, secret, spaceApp } from '@opencroft/db'
import { eq } from 'drizzle-orm'

import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { referencesLostWithGraph } from './secret-store-removal'
import { secrets } from './secrets'

// The secrets-store inspector's manual "Add Secret" rows call secrets.set()
// sequentially, once per dirty row, same as this test does. If this passes but
// the UI still loses a secret, the defect is in the extension's
// invoke()/action-registry plumbing, not in this underlying write path.
test('sequential set() calls for multiple keys on one store all land, and list() reflects all of them', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`

  await secrets.set(storeId, 'FIRST', 'value-one')
  await secrets.set(storeId, 'SECOND', 'value-two')

  const rows = await secrets.list(storeId)
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  assert.equal(byKey.get('FIRST'), 'value-one')
  assert.equal(byKey.get('SECOND'), 'value-two')
  assert.equal(rows.length, 2)
})

test('set() on an existing key updates the value in place instead of erroring or duplicating', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`

  await secrets.set(storeId, 'KEY', 'original')
  await secrets.set(storeId, 'KEY', 'rotated')

  const rows = await secrets.list(storeId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].value, 'rotated')
})

test('set() keeps the recipe it is given, records a value set without one as typed, and replaces it on the next set', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`

  await secrets.set(storeId, 'MADE', 'x'.repeat(64), { kind: 'random', length: 64, format: 'symbols' })
  await secrets.set(storeId, 'BROUGHT', 'sk-typed')
  const recipes = new Map((await secrets.list(storeId)).map((r) => [r.key, r.recipe]))
  assert.deepEqual(recipes.get('MADE'), { kind: 'random', length: 64, format: 'symbols' })
  assert.deepEqual(recipes.get('BROUGHT'), { kind: 'typed' })

  await secrets.set(storeId, 'MADE', `Bearer ${'x'.repeat(40)}`, {
    kind: 'bearer',
    token: { length: 40, format: 'base64url' },
  })
  const [made] = (await secrets.list(storeId)).filter((r) => r.key === 'MADE')
  assert.deepEqual(made.recipe, { kind: 'bearer', token: { length: 40, format: 'base64url' } })
})

test('a row stored without a recipe lists with recipe null', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`
  await secrets.set(storeId, 'CONTROL', 'v')
  const [control] = await secrets.list(storeId)
  assert.ok(control.recipe !== null, 'the control: set() always writes one')

  await db.update(secret).set({ recipe: null }).where(eq(secret.storeId, storeId))
  const [row] = await secrets.list(storeId)
  assert.equal(row.recipe, null)
  assert.equal(row.value, 'v')
})

test('delete() then set() on the same key recreates it, matching the row-remove-then-readd UI flow', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`

  await secrets.set(storeId, 'KEY', 'v1')
  await secrets.delete(storeId, 'KEY')
  assert.equal(await secrets.get(storeId, 'KEY'), null)

  await secrets.set(storeId, 'KEY', 'v2')
  assert.equal(await secrets.get(storeId, 'KEY'), 'v2')
})

test('rename() moves the one row to the new name with its id, value, recipe and age, and the old name is gone', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`
  const recipe = { kind: 'random', length: 64, format: 'symbols' } as const
  await secrets.set(storeId, 'OLD', 'x'.repeat(64), recipe)
  const before = await db.query.secret.findFirst({ where: eq(secret.storeId, storeId) })

  await secrets.rename(storeId, 'OLD', 'NEW')

  const rows = await secrets.list(storeId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, 'NEW')
  assert.equal(rows[0].id, before?.id)
  assert.equal(rows[0].value, 'x'.repeat(64))
  assert.deepEqual(rows[0].recipe, recipe)
  const after = await db.query.secret.findFirst({ where: eq(secret.storeId, storeId) })
  assert.equal(after?.createdAt.getTime(), before?.createdAt.getTime())
  assert.equal(await secrets.get(storeId, 'OLD'), null)
})

test('rename() onto a name the store holds is refused and both secrets keep their values', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`
  await secrets.set(storeId, 'OLD', 'old-value')
  await secrets.set(storeId, 'TAKEN', 'taken-value')

  await assert.rejects(secrets.rename(storeId, 'OLD', 'TAKEN'), /^Error: Secret "TAKEN" is already in this store$/)

  assert.equal(await secrets.get(storeId, 'OLD'), 'old-value')
  assert.equal(await secrets.get(storeId, 'TAKEN'), 'taken-value')
})

test('rename() of a name the store does not hold is refused and creates nothing', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`
  await secrets.set(storeId, 'OTHER', 'v')
  // The same name in another store is not this store's to rename.
  await secrets.set(`${storeId}-elsewhere`, 'OLD', 'v')

  await assert.rejects(secrets.rename(storeId, 'OLD', 'NEW'), /^Error: Secret "OLD" is not in this store$/)

  assert.deepEqual(await secrets.listKeys(storeId), ['OTHER'])
  assert.deepEqual(await secrets.listKeys(`${storeId}-elsewhere`), ['OLD'])
})

// The orphan listing reads every store's rows. One row the instance's key
// cannot decrypt (restored from another instance) must not take the listing
// down with it, and no value is carried, decrypted or not.
test('listAllKeys() lists every row without a value, undecryptable ones included', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`
  await secrets.set(storeId, 'READABLE', 'plain-value')
  await db.insert(secret).values({ storeId, key: 'UNREADABLE', value: 'not-ciphertext' })
  try {
    await assert.rejects(() => secrets.listAll(), 'the control: decrypting every row fails on the unreadable one')

    const listed = (await secrets.listAllKeys()).filter((r) => r.storeId === storeId)
    assert.deepEqual(listed.map((r) => r.key).sort(), ['READABLE', 'UNREADABLE'])
    for (const r of listed) {
      assert.deepEqual(Object.keys(r).sort(), ['id', 'key', 'storeId', 'updatedAt'])
    }
  } finally {
    await secrets.delete(storeId, 'UNREADABLE')
  }
})

test('listDecryptableValues() leaves out a row the instance cannot decrypt instead of failing', async () => {
  const storeId = `secrets-test-${crypto.randomUUID()}`
  await secrets.set(storeId, 'READABLE', 'readable-value')
  await db.insert(secret).values({ storeId, key: 'UNREADABLE', value: 'not-ciphertext' })
  try {
    const values = await secrets.listDecryptableValues()
    assert.ok(values.includes('readable-value'))
    assert.ok(!values.includes('not-ciphertext'))
  } finally {
    await secrets.delete(storeId, 'UNREADABLE')
  }
})

const STORE_TYPE = 'builtin.core.core-secrets-store'
let spaces = 0

/**
 * A fresh space whose default graph holds a Secrets Store with `values` and one other node, the
 * one a field naming a secret sits on. Answers their ids and the graph's address.
 */
async function graphWithStore(values: Record<string, string>) {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `secrets-scope-${crypto.randomUUID().slice(0, 8)}-${spaces++}`
  const storeId = `store-${slug}`
  const nodeId = `node-${slug}`
  const space = await registry.create(slug, slug, {
    nodes: [
      { id: storeId, type: STORE_TYPE, position: { x: 0, y: 0 }, data: { secretKeys: Object.keys(values) } },
      { id: nodeId, type: 'builtin.core.script', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [],
  })
  for (const [key, value] of Object.entries(values)) {
    await secrets.set(storeId, key, value)
  }
  const [graph] = registry.graphsOf(space.slug)
  return { spaceSlug: space.slug, storeId, nodeId, address: `${space.slug}.${graph.slug}` }
}

test('resolveValue() resolves secret:NAME, trimmed, and returns typed text as it is', async () => {
  const key = `RESOLVE_${crypto.randomUUID().slice(0, 8)}`
  const { nodeId } = await graphWithStore({ [key]: 'resolved-value' })
  const scope = { nodeId }
  assert.equal(await secrets.resolveValue(`secret:${key}`, scope), 'resolved-value')
  assert.equal(await secrets.resolveValue(`secret:  ${key} `, scope), 'resolved-value')
  assert.equal(await secrets.resolveValue('typed-value', scope), 'typed-value')
  assert.equal(await secrets.resolveValue(' typed value ', scope), ' typed value ')
  assert.equal(await secrets.resolveValue('', scope), '')
  // Only a leading prefix names a secret; one inside the text is sent as typed.
  assert.equal(await secrets.resolveValue(`Bearer secret:${key}`, scope), `Bearer secret:${key}`)
})

test('a name two graphs both hold resolves to each graph’s own value, not the older one', async () => {
  const key = `CLASH_${crypto.randomUUID().slice(0, 8)}`
  const older = await graphWithStore({ [key]: 'older-graph-value' })
  const newer = await graphWithStore({ [key]: 'newer-graph-value' })
  assert.equal(
    await secrets.resolveOnInstance(key),
    'older-graph-value',
    'the control: across the instance the older row wins',
  )

  assert.equal(await secrets.resolveValue(`secret:${key}`, { nodeId: newer.nodeId }), 'newer-graph-value')
  assert.equal(await secrets.resolve(key, { nodeId: newer.nodeId }), 'newer-graph-value')
  assert.equal(await secrets.resolve(key, { nodeId: older.nodeId }), 'older-graph-value')
})

test('a name only another space holds does not resolve, and the error names the graph', async () => {
  const key = `ELSEWHERE_${crypto.randomUUID().slice(0, 8)}`
  await graphWithStore({ [key]: 'other-space-value' })
  const asking = await graphWithStore({})

  assert.equal(await secrets.resolve(key, { nodeId: asking.nodeId }), null)
  assert.equal(await secrets.resolve(key, { spaceSlug: asking.spaceSlug }), null)
  await assert.rejects(
    () => secrets.resolveValue(`secret:${key}`, { nodeId: asking.nodeId }),
    (err: Error) => err.message === `Secret "${key}" not found in any Secrets Store on graph ${asking.address}`,
  )
  await assert.rejects(() => secrets.resolveValue('secret:  ', { nodeId: asking.nodeId }), /not found/)
})

test('a space scope reads the stores on every graph of the space and on no other', async () => {
  const key = `SPACE_${crypto.randomUUID().slice(0, 8)}`
  const home = await graphWithStore({})
  const registry = getSpacesRegistry()
  const second = await registry.createGraph(home.spaceSlug, 'Second', 'second', `instance-${home.spaceSlug}`)
  const storeId = `store-second-${home.spaceSlug}`
  await mutateLiveGraph(
    `${home.spaceSlug}.${second.slug}`,
    { kind: 'user', name: 'alice' },
    (graph) => {
      graph.nodes.push({ id: storeId, type: STORE_TYPE, position: { x: 0, y: 0 }, data: { secretKeys: [key] } })
    },
    { resolveContexts: false },
  )
  await secrets.set(storeId, key, 'second-graph-value')
  const other = await graphWithStore({})

  assert.equal(await secrets.resolve(key, { spaceSlug: home.spaceSlug }), 'second-graph-value')
  assert.equal(await secrets.resolve(key, { nodeId: home.nodeId }), null, 'a node reads its own graph only')
  assert.equal(await secrets.resolve(key, { spaceSlug: other.spaceSlug }), null)
})

test('namesIn() lists the names a scope resolves, sorted and once each, and none from elsewhere', async () => {
  const tag = crypto.randomUUID().slice(0, 8)
  const home = await graphWithStore({ [`B_${tag}`]: 'b', [`A_${tag}`]: 'a' })
  const registry = getSpacesRegistry()
  const second = await registry.createGraph(home.spaceSlug, 'Second', 'second', `instance-n-${home.spaceSlug}`)
  const storeId = `store-names-${home.spaceSlug}`
  await mutateLiveGraph(
    `${home.spaceSlug}.${second.slug}`,
    { kind: 'user', name: 'alice' },
    (graph) => {
      graph.nodes.push({ id: storeId, type: STORE_TYPE, position: { x: 0, y: 0 }, data: { secretKeys: [] } })
    },
    { resolveContexts: false },
  )
  await secrets.set(storeId, `C_${tag}`, 'c')
  await secrets.set(storeId, `A_${tag}`, 'a-again')
  await graphWithStore({ [`OTHER_${tag}`]: 'other' })
  await secrets.set(home.nodeId, `NOT_A_STORE_${tag}`, 'row-under-a-script-node')

  assert.deepEqual(await secrets.namesIn({ spaceSlug: home.spaceSlug }), [`A_${tag}`, `B_${tag}`, `C_${tag}`])
  assert.deepEqual(await secrets.namesIn({ nodeId: home.nodeId }), [`A_${tag}`, `B_${tag}`])
  assert.deepEqual(await secrets.namesIn({ spaceSlug: (await graphWithStore({})).spaceSlug }), [])
  await assert.rejects(() => secrets.namesIn({ spaceSlug: 'no-such-space' }), /no-such-space not found/)
})

test('a row keyed by a node that is no Secrets Store is not in scope', async () => {
  const key = `NOT_A_STORE_${crypto.randomUUID().slice(0, 8)}`
  const { nodeId } = await graphWithStore({})
  await secrets.set(nodeId, key, 'row-under-a-script-node')
  assert.equal(await secrets.resolve(key, { nodeId }), null)
})

test('a call without a scope, or with one naming nothing, is refused rather than resolved anywhere', async () => {
  const key = `UNSCOPED_${crypto.randomUUID().slice(0, 8)}`
  await graphWithStore({ [key]: 'value' })
  const unscoped = secrets as unknown as { resolve(key: string): Promise<string | null> }
  await assert.rejects(() => unscoped.resolve(key), /pass the node or the space/)
  await assert.rejects(() => secrets.resolve(key, { nodeId: '' }), /pass the node or the space/)
  await assert.rejects(() => secrets.resolve(key, { nodeId: 'no-such-node' }), /no-such-node is on no graph/)
  await assert.rejects(() => secrets.resolve(key, { spaceSlug: 'no-such-space' }), /no-such-space not found/)
})

// ── Who resolves from a store ────────────────────────────────────────────
// The reverse of the scopes above: the nodes on the store's graph and the Apps
// of its space, and nothing for a store on no graph.

async function addNodes(address: string, nodes: Record<string, unknown>[]): Promise<void> {
  await mutateLiveGraph(
    address,
    { kind: 'user', name: 'alice' },
    (graph) => {
      graph.nodes.push(...(nodes as (typeof graph.nodes)[number][]))
    },
    { resolveContexts: false },
  )
}

async function addApp(spaceSlug: string, slug: string, params: Record<string, string>): Promise<void> {
  const space = getSpacesRegistry().getBySlug(spaceSlug)
  assert.ok(space, `space ${spaceSlug} exists`)
  await db
    .insert(spaceApp)
    .values({ spaceId: space.id, type: 'acme.docs.docs', name: `App ${slug}`, slug, params: JSON.stringify(params) })
}

function scriptNode(id: string, data: Record<string, unknown>): Record<string, unknown> {
  return { id, type: 'builtin.core.script', position: { x: 0, y: 0 }, data }
}

test('references() lists the nodes on the store’s graph and the Apps of its space that name the key', async () => {
  const key = `REFS_${crypto.randomUUID().slice(0, 8)}`
  const home = await graphWithStore({ [key]: 'value' })
  await addNodes(home.address, [scriptNode(`user-${home.spaceSlug}`, { name: 'worker', secrets: key })])
  await addApp(home.spaceSlug, 'docs', { token: `secret:${key}` })
  // Another graph of the same space resolves from its own stores, not this one.
  const second = await getSpacesRegistry().createGraph(
    home.spaceSlug,
    'Second',
    'second',
    `instance-r-${home.spaceSlug}`,
  )
  await addNodes(`${home.spaceSlug}.${second.slug}`, [scriptNode(`second-${home.spaceSlug}`, { secrets: key })])
  const other = await graphWithStore({})
  await addNodes(other.address, [scriptNode(`other-${other.spaceSlug}`, { secrets: key })])
  await addApp(other.spaceSlug, 'docs', { token: `secret:${key}` })

  assert.deepEqual(await secrets.references(home.storeId, key), [
    { nodeId: `user-${home.spaceSlug}`, nodeType: 'builtin.core.script', nodeName: 'worker' },
    { nodeId: `${home.spaceSlug}.docs`, nodeType: 'app:acme.docs.docs', nodeName: 'App docs' },
  ])
  assert.equal((await secrets.references(other.storeId, key)).length, 2, 'the control: the other space names it too')
})

test('references() finds nothing for a store on no graph, whoever names the key', async () => {
  const key = `ORPHAN_${crypto.randomUUID().slice(0, 8)}`
  const home = await graphWithStore({})
  await addNodes(home.address, [scriptNode(`user-${home.spaceSlug}`, { secrets: key })])
  const orphanStore = `gone-store-${home.spaceSlug}`
  await secrets.set(orphanStore, key, 'orphan-value')

  assert.deepEqual(await secrets.references(orphanStore, key), [])
  assert.equal(
    await secrets.resolve(key, { nodeId: `user-${home.spaceSlug}` }),
    null,
    'the node naming it cannot resolve the orphan row either',
  )
  await secrets.deleteStore(orphanStore)
})

test('referencesToStores() leaves out the nodes deleted with the stores and lists each name once', async () => {
  const named = `NAMED_${crypto.randomUUID().slice(0, 8)}`
  const unnamed = `UNNAMED_${crypto.randomUUID().slice(0, 8)}`
  const home = await graphWithStore({ [named]: 'a', [unnamed]: 'b' })
  const secondStore = `store-two-${home.spaceSlug}`
  await addNodes(home.address, [
    { id: secondStore, type: STORE_TYPE, position: { x: 0, y: 0 }, data: { secretKeys: [named] } },
    scriptNode(`stays-${home.spaceSlug}`, { secrets: named }),
    scriptNode(`goes-${home.spaceSlug}`, { secrets: `${named}\n${unnamed}` }),
  ])
  await secrets.set(secondStore, named, 'c')

  const found = await secrets.referencesToStores([home.storeId, secondStore], [`goes-${home.spaceSlug}`])
  assert.deepEqual(found, [
    {
      key: named,
      references: [{ nodeId: `stays-${home.spaceSlug}`, nodeType: 'builtin.core.script', nodeName: undefined }],
    },
  ])
  assert.equal(
    (await secrets.referencesToStores([home.storeId])).length,
    2,
    'the control: without the deletion both names are named',
  )
})

test('removing a graph lists the Apps of its space that name its stores’ secrets, and none of its own nodes', async () => {
  const key = `GRAPH_${crypto.randomUUID().slice(0, 8)}`
  const home = await graphWithStore({})
  const instanceId = `instance-g-${home.spaceSlug}`
  const graph = await getSpacesRegistry().createGraph(home.spaceSlug, 'Doomed', 'doomed', instanceId)
  const storeId = `store-doomed-${home.spaceSlug}`
  await addNodes(`${home.spaceSlug}.${graph.slug}`, [
    { id: storeId, type: STORE_TYPE, position: { x: 0, y: 0 }, data: { secretKeys: [key] } },
    scriptNode(`doomed-user-${home.spaceSlug}`, { secrets: key }),
  ])
  await secrets.set(storeId, key, 'value')
  await addApp(home.spaceSlug, 'docs', { token: `secret:${key}` })

  assert.deepEqual(await referencesLostWithGraph(instanceId), [
    { key, references: [{ nodeId: `${home.spaceSlug}.docs`, nodeType: 'app:acme.docs.docs', nodeName: 'App docs' }] },
  ])
  assert.deepEqual(await referencesLostWithGraph(`no-such-instance-${home.spaceSlug}`), [])
})
