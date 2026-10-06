// Stored state of a collaborative document. Exercises the real database
// (embedded PGlite by default) -- see @opencroft/db's test-env.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { collabDocUpdate, db } from '@opencroft/db'
import { eq } from 'drizzle-orm'
import * as Y from 'yjs'

import {
  appendCollabUpdate,
  createCollabDoc,
  deleteCollabDoc,
  listCollabDocNames,
  loadCollabDoc,
  writeCollabSnapshot,
} from '@/server/collab/collab-store'

function docWith(entries: Record<string, number>): Y.Doc {
  const doc = new Y.Doc()
  for (const [key, value] of Object.entries(entries)) {
    doc.getMap('m').set(key, value)
  }
  return doc
}

function valuesOf(state: Uint8Array): Record<string, unknown> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc.getMap('m').toJSON()
}

// Captures the update a change to `doc` produces, as the server records it.
function updateOf(doc: Y.Doc, change: () => void): Uint8Array {
  let captured: Uint8Array | null = null
  const capture = (update: Uint8Array) => {
    captured = update
  }
  doc.on('update', capture)
  change()
  doc.off('update', capture)
  assert.ok(captured, 'the change produced an update')
  return captured
}

test('a missing document loads as null', async () => {
  assert.equal(await loadCollabDoc(`test:${crypto.randomUUID()}`), null)
})

test('a loaded document is its snapshot with every recorded update applied', async () => {
  const name = `test:${crypto.randomUUID()}`
  const doc = docWith({ a: 1 })
  await createCollabDoc(name, { state: Y.encodeStateAsUpdate(doc), sourceVersion: 'v1', schemaVersion: 1 })
  await appendCollabUpdate(
    name,
    updateOf(doc, () => doc.getMap('m').set('b', 2)),
  )
  await appendCollabUpdate(
    name,
    updateOf(doc, () => doc.getMap('m').set('a', 3)),
  )
  const loaded = await loadCollabDoc(name)
  assert.ok(loaded)
  assert.deepEqual(valuesOf(loaded.state), { a: 3, b: 2 })
  assert.equal(loaded.sourceVersion, 'v1')
  assert.equal(loaded.schemaVersion, 1)
})

// Resolves once the clock has moved past the current millisecond, so a row
// recorded after this is strictly later than a time taken before it.
async function nextMillisecond(): Promise<void> {
  const now = Date.now()
  while (Date.now() === now) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function updateRows(name: string): Promise<number> {
  const rows = await db.select().from(collabDocUpdate).where(eq(collabDocUpdate.name, name))
  return rows.length
}

test('a snapshot drops the updates it covers and keeps later ones', async () => {
  const name = `test:${crypto.randomUUID()}`
  const doc = docWith({ a: 1 })
  await createCollabDoc(name, { state: Y.encodeStateAsUpdate(doc), sourceVersion: 'v1', schemaVersion: 1 })
  await appendCollabUpdate(
    name,
    updateOf(doc, () => doc.getMap('m').set('b', 2)),
  )
  await nextMillisecond()
  const coveredUntil = new Date()
  const snapshot = Y.encodeStateAsUpdate(doc)
  // Recorded after the snapshot was taken, so not in it.
  await appendCollabUpdate(
    name,
    updateOf(doc, () => doc.getMap('m').set('c', 3)),
  )
  await writeCollabSnapshot(name, { state: snapshot, sourceVersion: 'v2', coveredUntil })

  assert.equal(await updateRows(name), 1)
  const loaded = await loadCollabDoc(name)
  assert.ok(loaded)
  assert.deepEqual(valuesOf(loaded.state), { a: 1, b: 2, c: 3 })
  assert.equal(loaded.sourceVersion, 'v2')
})

test('an update recorded in the same millisecond as the snapshot time is kept', async () => {
  const name = `test:${crypto.randomUUID()}`
  const doc = docWith({ a: 1 })
  await createCollabDoc(name, { state: Y.encodeStateAsUpdate(doc), sourceVersion: 'v1', schemaVersion: 1 })
  const coveredUntil = new Date()
  const snapshot = Y.encodeStateAsUpdate(doc)
  const late = updateOf(doc, () => doc.getMap('m').set('c', 3))
  await db
    .insert(collabDocUpdate)
    .values({ name, update: Buffer.from(late).toString('base64'), createdAt: coveredUntil })
  await writeCollabSnapshot(name, { state: snapshot, sourceVersion: 'v2', coveredUntil })
  const loaded = await loadCollabDoc(name)
  assert.ok(loaded)
  assert.deepEqual(valuesOf(loaded.state), { a: 1, c: 3 })
})

test('creating a document again starts a new lineage and drops the old history', async () => {
  const name = `test:${crypto.randomUUID()}`
  const first = docWith({ a: 1 })
  const lineage = await createCollabDoc(name, {
    state: Y.encodeStateAsUpdate(first),
    sourceVersion: 'v1',
    schemaVersion: 1,
  })
  await appendCollabUpdate(
    name,
    updateOf(first, () => first.getMap('m').set('b', 2)),
  )
  const rebuilt = await createCollabDoc(name, {
    state: Y.encodeStateAsUpdate(docWith({ z: 9 })),
    sourceVersion: 'v2',
    schemaVersion: 1,
  })
  assert.notEqual(rebuilt, lineage)
  const loaded = await loadCollabDoc(name)
  assert.ok(loaded)
  assert.equal(loaded.lineage, rebuilt)
  assert.deepEqual(valuesOf(loaded.state), { z: 9 })
})

test('a deleted document is gone from the names and loads as null', async () => {
  const name = `test:${crypto.randomUUID()}`
  await createCollabDoc(name, {
    state: Y.encodeStateAsUpdate(docWith({ a: 1 })),
    sourceVersion: 'v1',
    schemaVersion: 1,
  })
  assert.ok((await listCollabDocNames()).includes(name))
  await deleteCollabDoc(name)
  assert.equal((await listCollabDocNames()).includes(name), false)
  assert.equal(await loadCollabDoc(name), null)
})
