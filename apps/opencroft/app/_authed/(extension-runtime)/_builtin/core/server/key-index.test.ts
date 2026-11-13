import assert from 'node:assert/strict'
import test from 'node:test'

import type { GraphNodeRecord } from '@opencroft/server/graph'

import { type KeyIndexSource, syncKeyIndex } from './key-index'

const STORE_TYPE = 'acme.core.core-key-store'

let stores = 0

/** One node on a fake graph, whose key files hold `files`; `updates` records every data patch written. */
function fakeStore(files: string[], node: Partial<GraphNodeRecord> = {}) {
  const id = `store-${stores++}`
  const stored: GraphNodeRecord = { id, type: STORE_TYPE, position: { x: 0, y: 0 }, data: {}, ...node }
  const updates: Array<Record<string, unknown>> = []
  const source: KeyIndexSource = {
    listNames: async () => [...files],
    graph: {
      getNode: async (nodeId) => (nodeId === id ? { ...stored, data: { ...stored.data } } : null),
      updateNode: async (nodeId, patch) => {
        assert.equal(nodeId, id)
        updates.push(patch.data ?? {})
        stored.data = { ...stored.data, ...patch.data }
        return stored
      },
    },
    storeType: STORE_TYPE,
  }
  return { id, stored, updates, source }
}

test('writes the names the files hold to a store whose list lacks them', async () => {
  const store = fakeStore(['deploy', 'backup'], { data: { keyNames: [] } })
  assert.equal(await syncKeyIndex(store.id, store.source), true)
  assert.deepEqual(store.stored.data.keyNames, ['deploy', 'backup'])
})

test('writes a list to a store node created without one', async () => {
  const store = fakeStore(['deploy'])
  assert.equal(await syncKeyIndex(store.id, store.source), true)
  assert.deepEqual(store.stored.data.keyNames, ['deploy'])
})

test('drops a name whose key files are gone', async () => {
  const store = fakeStore(['backup'], { data: { keyNames: ['deploy', 'backup'] } })
  await syncKeyIndex(store.id, store.source)
  assert.deepEqual(store.stored.data.keyNames, ['backup'])
})

test('writes only the list, leaving the rest of the node data as it is', async () => {
  const store = fakeStore(['deploy'], { data: { keyNames: [], label: 'Keys' } })
  await syncKeyIndex(store.id, store.source)
  assert.deepEqual(store.updates, [{ keyNames: ['deploy'] }])
  assert.equal(store.stored.data.label, 'Keys')
})

test('writes nothing when the list already holds the names in order', async () => {
  const store = fakeStore(['deploy', 'backup'], { data: { keyNames: ['deploy', 'backup'] } })
  assert.equal(await syncKeyIndex(store.id, store.source), false)
  assert.deepEqual(store.updates, [])
})

test('writes nothing to a node of another type', async () => {
  const store = fakeStore(['deploy'], { type: 'acme.core.server', data: {} })
  assert.equal(await syncKeyIndex(store.id, store.source), false)
  assert.deepEqual(store.updates, [])
})

test('writes nothing when no node has the id', async () => {
  const store = fakeStore(['deploy'])
  assert.equal(await syncKeyIndex('no-such-node', store.source), false)
  assert.deepEqual(store.updates, [])
})

test('two updates of one store racing leave the list of the later write', async () => {
  const store = fakeStore([], { data: { keyNames: [] } })
  let files = ['deploy']
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let firstRead: () => void = () => undefined
  const firstHasRead = new Promise<void>((resolve) => {
    firstRead = resolve
  })
  // The first update reads the files, then stalls before writing, as a slow read of a large store would.
  let reads = 0
  const slowSource: KeyIndexSource = {
    ...store.source,
    listNames: async () => {
      const names = [...files]
      if (reads++ === 0) {
        firstRead()
        await held
      }
      return names
    },
  }
  const first = syncKeyIndex(store.id, slowSource)
  await firstHasRead
  files = ['deploy', 'backup']
  const second = syncKeyIndex(store.id, slowSource)
  // Room for the second update to finish, were it not waiting for the first.
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await Promise.all([first, second])
  assert.deepEqual(store.stored.data.keyNames, ['deploy', 'backup'])
})

test('a failed update does not hold up the next one of the same store', async () => {
  const store = fakeStore(['deploy'], { data: { keyNames: [] } })
  const failing: KeyIndexSource = {
    ...store.source,
    listNames: async () => {
      throw new Error('store directory unreadable')
    },
  }
  await assert.rejects(syncKeyIndex(store.id, failing), /store directory unreadable/)
  assert.equal(await syncKeyIndex(store.id, store.source), true)
  assert.deepEqual(store.stored.data.keyNames, ['deploy'])
})
