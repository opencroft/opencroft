import assert from 'node:assert/strict'
import test from 'node:test'

import type { NodeReference } from '../src/nodes/delete-refusal-shared'
import { type DeleteOverride, deleteChecked, nameReferences, shownOverride } from './checked-delete'

/** A store holding `keys`, named by `references`, that records whether it removed anything. */
function fakeStore(keys: string[], references: NodeReference[]) {
  const store = {
    removed: 0,
    listKeys: async () => keys,
    listReferences: async () => references,
    remove: async () => {
      store.removed += 1
    },
  }
  return store
}

const messages = {
  absent: (name: string) => `absent: ${name}`,
  refused: (name: string, references: NodeReference[]) => `refused: ${name} by ${nameReferences(references)}`,
}

function deleteWith(override: DeleteOverride, store: ReturnType<typeof fakeStore>) {
  return deleteChecked('deploy', override, store, messages)
}

const server = { nodeId: 'node-1', nodeType: 'server', nodeName: 'web' }
const worker = { nodeId: 'node-2', nodeType: 'agent' }

test('an item nothing names is deleted', async () => {
  const store = fakeStore(['deploy'], [])
  assert.deepEqual(await deleteWith(false, store), { deleted: 'deploy' })
  assert.equal(store.removed, 1)
})

test('an item a node names is refused with the caller’s message and the nodes, and nothing is removed', async () => {
  const store = fakeStore(['deploy'], [server, worker])
  assert.deepEqual(await deleteWith(false, store), {
    refused: { references: [server, worker], message: 'refused: deploy by web (node-1), agent (node-2)' },
  })
  assert.equal(store.removed, 0)
})

test('`true` deletes an item nodes still name', async () => {
  const store = fakeStore(['deploy'], [server, worker])
  assert.deepEqual(await deleteWith(true, store), { deleted: 'deploy' })
  assert.equal(store.removed, 1)
})

test('a list of node ids deletes past exactly the nodes it lists', async () => {
  const store = fakeStore(['deploy'], [server, worker])
  assert.deepEqual(await deleteWith(['node-1', 'node-2'], store), { deleted: 'deploy' })
  assert.equal(store.removed, 1)
})

test('a list is refused when a node it does not list names the item, and the refusal lists every node', async () => {
  // The confirm showed `server`; `worker` started naming the item while it was open.
  const store = fakeStore(['deploy'], [server, worker])
  const outcome = await deleteWith(['node-1'], store)
  assert.ok('refused' in outcome)
  assert.deepEqual(outcome.refused.references, [server, worker])
  assert.equal(store.removed, 0)
})

test('an empty list is refused like no override', async () => {
  const store = fakeStore(['deploy'], [server])
  assert.ok('refused' in (await deleteWith([], store)))
  assert.equal(store.removed, 0)
})

test('a listed node that does not name the item at delete time does not hold the delete back', async () => {
  const store = fakeStore(['deploy'], [])
  assert.deepEqual(await deleteWith(['node-1'], store), { deleted: 'deploy' })
  assert.equal(store.removed, 1)
})

test('a name the store does not hold throws the caller’s message, whatever the override, and nothing is removed', async () => {
  for (const override of [false, true, ['node-1']] as DeleteOverride[]) {
    const store = fakeStore(['other'], [])
    await assert.rejects(deleteWith(override, store), { message: 'absent: deploy' })
    assert.equal(store.removed, 0)
  }
})

test('an inspector’s list of shown ids is its override, keeping only the ids', () => {
  assert.deepEqual(shownOverride(['node-1', 7, null, 'node-2']), ['node-1', 'node-2'])
  assert.deepEqual(shownOverride([]), [])
})

test('an inspector value that is not a list overrides nothing, `true` included', () => {
  for (const shown of [true, 'node-1', undefined, null, { 0: 'node-1' }]) {
    assert.equal(shownOverride(shown), false)
  }
})

test('a node with no name of its own is named by its type, then as a node, with its id', () => {
  assert.equal(nameReferences([server, worker, { nodeId: 'node-3' }]), 'web (node-1), agent (node-2), node (node-3)')
})
