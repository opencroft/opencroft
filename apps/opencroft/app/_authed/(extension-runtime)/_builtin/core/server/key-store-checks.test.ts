import assert from 'node:assert/strict'
import test from 'node:test'

import type { GraphNodeRecord } from '@opencroft/server/graph'

import type { NodeReference } from '../src/nodes/delete-refusal-shared'
import {
  checkKeyReference,
  deleteKeyChecked,
  findKeyReferences,
  keyStoreLookupOn,
  regenerableKeyType,
  requireHeldKey,
  requireKeyType,
  requireNewKeyName,
} from './key-store-checks'

function node(id: string, data: Record<string, unknown>, type = 'builtin.core.server'): GraphNodeRecord {
  return { id, type, position: { x: 0, y: 0 }, data } as GraphNodeRecord
}

// ── requireNewKeyName ────────────────────────────────────────────────────

test('requireNewKeyName trims and keeps a plain name', () => {
  assert.equal(requireNewKeyName('  deploy-2_rc.v1 '), 'deploy-2_rc.v1')
})

test('requireNewKeyName refuses a name with a path in it, quoting it as given', () => {
  assert.throws(() => requireNewKeyName('bad name/../x'), /Key name "bad name\/\.\.\/x" is not allowed/)
  assert.throws(() => requireNewKeyName('../outside'), /is not allowed/)
  assert.throws(() => requireNewKeyName('..'), /is not allowed/)
  assert.throws(() => requireNewKeyName('a\\b'), /is not allowed/)
})

test('requireNewKeyName refuses a dot-file name and a public-half name', () => {
  assert.throws(() => requireNewKeyName('.hidden'), /is not allowed/)
  assert.throws(() => requireNewKeyName('id_ed25519.pub'), /is not allowed/)
})

test('requireNewKeyName refuses a name too long for a file with its .pub', () => {
  assert.equal(requireNewKeyName('k'.repeat(251)).length, 251)
  assert.throws(() => requireNewKeyName('k'.repeat(252)), /at most 251 characters/)
})

test('requireNewKeyName refuses an empty or non-string name', () => {
  assert.throws(() => requireNewKeyName('  '), /Key name is required/)
  assert.throws(() => requireNewKeyName(undefined), /Key name is required/)
})

// ── requireKeyType ───────────────────────────────────────────────────────

test('requireKeyType defaults to ed25519 and refuses an unknown type', () => {
  assert.equal(requireKeyType(undefined), 'ed25519')
  assert.equal(requireKeyType('rsa'), 'rsa')
  assert.throws(() => requireKeyType('dsa'), /Unsupported key type "dsa"/)
})

test('requireKeyType takes the fallback for an absent or blank type, not for a given one', () => {
  assert.equal(requireKeyType(undefined, 'rsa'), 'rsa')
  assert.equal(requireKeyType('', 'rsa'), 'rsa')
  assert.equal(requireKeyType('  ', 'ecdsa'), 'ecdsa')
  assert.equal(requireKeyType('ed25519', 'rsa'), 'ed25519')
})

test('regenerableKeyType maps an inspected type the store can generate, and nothing else', () => {
  assert.equal(regenerableKeyType('ED25519'), 'ed25519')
  assert.equal(regenerableKeyType('rsa'), 'rsa')
  assert.equal(regenerableKeyType('dsa'), undefined)
  assert.equal(regenerableKeyType(undefined), undefined)
})

// ── requireHeldKey ───────────────────────────────────────────────────────

test('requireHeldKey refuses a name the store does not hold', () => {
  assert.doesNotThrow(() => requireHeldKey('deploy', ['deploy']))
  assert.throws(() => requireHeldKey('nope', ['deploy']), /Key "nope" is not in this store/)
})

// ── checkKeyReference ────────────────────────────────────────────────────

const lookup = {
  isKeyStore: async (nodeId: string) => nodeId === 'store-1',
  listKeys: async (storeId: string) => (storeId === 'store-1' ? ['deploy', 'backup'] : []),
}

test('checkKeyReference returns a reference to a held key, trimmed', async () => {
  assert.equal(await checkKeyReference(' store-1:deploy ', lookup), 'store-1:deploy')
})

test('checkKeyReference refuses a missing key, naming it and the keys the store holds', async () => {
  await assert.rejects(
    checkKeyReference('store-1:missing-key', lookup),
    /Key "missing-key" is not in Key Store store-1; it holds deploy, backup/,
  )
})

test('checkKeyReference refuses a reference without a store or a name', async () => {
  await assert.rejects(checkKeyReference('deploy', lookup), /"deploy" is not a key reference/)
  await assert.rejects(checkKeyReference(':deploy', lookup), /is not a key reference/)
  await assert.rejects(checkKeyReference('store-1:', lookup), /is not a key reference/)
  await assert.rejects(checkKeyReference('', lookup), /A key reference is required/)
})

test('checkKeyReference refuses a store id that is not a Key Store on the graph', async () => {
  await assert.rejects(checkKeyReference('server-9:deploy', lookup), /No Key Store node "server-9" on this graph/)
})

// ── keyStoreLookupOn ─────────────────────────────────────────────────────

const KEY_STORE = 'builtin.core.core-key-store'
const listHeld = async (storeId: string) => (storeId.startsWith('store-') ? ['deploy'] : [])

test('a reference to a Key Store on the node’s graph is accepted', async () => {
  const graphNodes = [node('srv-1', {}), node('store-1', {}, KEY_STORE)]
  const onGraph = keyStoreLookupOn(graphNodes, KEY_STORE, listHeld)
  assert.equal(await checkKeyReference('store-1:deploy', onGraph), 'store-1:deploy')
})

test('a reference to a Key Store that is not on the node’s graph is refused, though the store holds the key', async () => {
  const graphNodes = [node('srv-1', {}), node('store-1', {}, KEY_STORE)]
  const onGraph = keyStoreLookupOn(graphNodes, KEY_STORE, listHeld)
  assert.deepEqual(await listHeld('store-elsewhere'), ['deploy'], 'the control: the other store holds the key')
  await assert.rejects(
    checkKeyReference('store-elsewhere:deploy', onGraph),
    /No Key Store node "store-elsewhere" on this graph/,
  )
})

test('a node on the graph that is not a Key Store is not taken for one', async () => {
  const graphNodes = [node('srv-1', {}), node('store-1', {}, 'builtin.core.core-secrets-store')]
  const onGraph = keyStoreLookupOn(graphNodes, KEY_STORE, listHeld)
  await assert.rejects(checkKeyReference('store-1:deploy', onGraph), /No Key Store node "store-1" on this graph/)
})

// ── findKeyReferences ────────────────────────────────────────────────────

const ROUTER = 'builtin.core.terminal-router'

// The store's graph holds the store, `srv-1` and `ext-1`; every other node id is on another graph.
const storeGraph = new Set(['store-1', 'srv-1', 'ext-1'])

const idsOf = (refs: NodeReference[]) => refs.map((ref) => ref.nodeId)

test('findKeyReferences finds a Server naming the key, by its name', () => {
  const nodes = [
    node('srv-1', { name: ' web ', keyPath: 'store-1:deploy' }),
    node('srv-2', { keyPath: 'store-1:backup' }),
  ]
  assert.deepEqual(findKeyReferences(nodes, 'store-1', 'deploy', storeGraph), [
    { nodeId: 'srv-1', nodeType: 'builtin.core.server', nodeName: 'web' },
  ])
})

test('findKeyReferences finds the reference in any field, nested', () => {
  const nodes = [node('ext-1', { target: { ssh: ['store-1:deploy'] } }, 'acme.tools.deployer')]
  assert.deepEqual(idsOf(findKeyReferences(nodes, 'store-1', 'deploy', storeGraph)), ['ext-1'])
})

test('findKeyReferences matches the whole reference only', () => {
  const nodes = [
    node('srv-1', { keyPath: 'store-2:deploy' }),
    node('srv-1b', { keyPath: 'store-1:deploy-old' }),
    node('ext-1', { note: 'uses store-1:deploy' }),
  ]
  assert.deepEqual(findKeyReferences(nodes, 'store-1', 'deploy', new Set([...storeGraph, 'srv-1b'])), [])
})

test('a node on another graph naming the key itself is not counted: its dial is refused', () => {
  const nodes = [node('srv-elsewhere', { keyPath: 'store-1:deploy' })]
  assert.deepEqual(findKeyReferences(nodes, 'store-1', 'deploy', storeGraph), [])
  assert.deepEqual(
    idsOf(findKeyReferences(nodes, 'store-1', 'deploy', new Set([...storeGraph, 'srv-elsewhere']))),
    ['srv-elsewhere'],
    'the control: on the store graph the same node is counted',
  )
})

// What a Server's terminal context looks like where it is copied: it names the Server it came from.
const serverContext = (scope: string) => ({
  type: 'ssh',
  host: '10.0.0.7',
  keyPath: 'store-1:deploy',
  credentialsScope: scope,
})

test('routed copies of a store-graph Server’s context on other graphs are counted', () => {
  const nodes = [
    node('router-b', { routes: [{ id: 'r1', target: 'srv-1/terminal', context: serverContext('srv-1') }] }, ROUTER),
    node('docker-b', { __resolvedContexts: { 'context-in': { value: serverContext('srv-1') } } }, 'acme.docker.docker'),
    node(
      'app-b',
      {
        __resolvedContexts: {
          'docker-in': { value: { type: 'docker-exec', containerId: 'c1', via: serverContext('srv-1') } },
        },
      },
      'acme.docker.application',
    ),
  ]
  assert.deepEqual(idsOf(findKeyReferences(nodes, 'store-1', 'deploy', storeGraph)), ['router-b', 'docker-b', 'app-b'])
})

test('a copied context scoped to a Server on another graph is not counted', () => {
  const nodes = [
    node('router-b', { routes: [{ id: 'r1', target: 'srv-x/terminal', context: serverContext('srv-x') }] }, ROUTER),
    node('app-b', { __resolvedContexts: { 'docker-in': { value: { via: serverContext('srv-x') } } } }),
  ]
  assert.deepEqual(findKeyReferences(nodes, 'store-1', 'deploy', storeGraph), [])
})

test('a copy scoped to a Server on another graph is not counted, though its holder is on the store graph', () => {
  const nodes = [node('ext-1', { copied: serverContext('srv-x') })]
  assert.deepEqual(findKeyReferences(nodes, 'store-1', 'deploy', storeGraph), [])
})

// ── deleteKeyChecked ─────────────────────────────────────────────────────

function fakeStore(keys: string[], references: NodeReference[]) {
  const removed: string[] = []
  return {
    removed,
    store: (name: string) => ({
      listKeys: async () => keys,
      listReferences: async () => references,
      remove: async () => {
        removed.push(name)
      },
    }),
  }
}

test('a key a node still names is refused, naming the node, and nothing is removed', async () => {
  const fake = fakeStore(['deploy'], [{ nodeId: 'srv-1', nodeName: 'web' }])
  const outcome = await deleteKeyChecked('deploy', false, fake.store('deploy'))
  assert.ok('refused' in outcome)
  assert.match(outcome.refused.message, /Refusing to delete key "deploy": 1 node still uses it — web \(srv-1\)/)
  assert.match(outcome.refused.message, /allowUnclean: true/)
  assert.deepEqual(outcome.refused.references, [{ nodeId: 'srv-1', nodeName: 'web' }])
  assert.deepEqual(fake.removed, [])
})

test('the override deletes a key a node still names', async () => {
  const fake = fakeStore(['deploy'], [{ nodeId: 'srv-1' }])
  assert.deepEqual(await deleteKeyChecked('deploy', true, fake.store('deploy')), { deleted: 'deploy' })
  assert.deepEqual(fake.removed, ['deploy'])
})

test('a key nothing names is deleted', async () => {
  const fake = fakeStore(['deploy'], [])
  assert.deepEqual(await deleteKeyChecked('deploy', false, fake.store('deploy')), { deleted: 'deploy' })
  assert.deepEqual(fake.removed, ['deploy'])
})

test('a name the store does not hold is refused as absent, and nothing is removed', async () => {
  const fake = fakeStore(['deploy'], [])
  await assert.rejects(deleteKeyChecked('nope', true, fake.store('nope')), /Key "nope" is not in this store/)
  assert.deepEqual(fake.removed, [])
})
