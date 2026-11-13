import assert from 'node:assert/strict'
import test from 'node:test'

import type { SecretKeyRecord } from '@opencroft/server/secrets'

import { orphanRows, refuseOrphanDelete } from './secret-orphans'

function row(id: string, storeId: string, key: string): SecretKeyRecord {
  return { id, storeId, key, updatedAt: new Date(0) }
}

// Two stores on the graph, and the rows of a third whose node was deleted.
const stores = [{ id: 'store-open' }, { id: 'store-other' }]
const rows = [
  row('own-1', 'store-open', 'OWN_TOKEN'),
  row('other-1', 'store-other', 'SESSION_SIGNING_KEY'),
  row('gone-1', 'store-deleted', 'LEFT_BEHIND'),
  row('gone-2', 'store-deleted', 'ALSO_LEFT'),
]

const notOnAGraph = /not on any saved graph/

test('a row of another live store is not an orphan; a row of a deleted store is', () => {
  assert.deepEqual(
    orphanRows('store-open', rows, stores).map((r) => r.id),
    ['gone-1', 'gone-2'],
  )
})

test('a store list without the asking store refuses to list orphans', () => {
  assert.throws(() => orphanRows('store-open', rows, []), notOnAGraph)
  assert.throws(() => orphanRows('store-open', rows, [{ id: 'store-other' }]), notOnAGraph)
})

test('a store list without the asking store refuses every orphan delete', () => {
  assert.match(refuseOrphanDelete('store-open', 'gone-1', rows, []) ?? '', notOnAGraph)
  assert.match(refuseOrphanDelete('store-open', 'other-1', rows, [{ id: 'store-other' }]) ?? '', notOnAGraph)
})

test('deleting a row of another live store is refused, naming the key', () => {
  assert.equal(
    refuseOrphanDelete('store-open', 'other-1', rows, stores),
    'Secret "SESSION_SIGNING_KEY" belongs to a Secrets Store that exists; delete it from that store',
  )
  assert.match(refuseOrphanDelete('store-open', 'own-1', rows, stores) ?? '', /OWN_TOKEN/)
})

test('deleting a row of a deleted store is allowed', () => {
  assert.equal(refuseOrphanDelete('store-open', 'gone-1', rows, stores), null)
})

test('deleting a row that does not exist is refused', () => {
  assert.equal(refuseOrphanDelete('store-open', 'missing', rows, stores), 'No such secret row')
})
