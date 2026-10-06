// Stored state of collaboratively edited documents: a snapshot per document
// plus the incremental updates applied since (see CollabDoc in the schema).
// Knows nothing about what a document holds; its owner decides that.

import { collabDoc, collabDocUpdate, type DB, db } from '@opencroft/db'
import { and, eq, lt } from 'drizzle-orm'
import * as Y from 'yjs'

/** A database handle or an open transaction on it. */
export type DbExecutor = DB | Parameters<Parameters<DB['transaction']>[0]>[0]

export interface StoredCollabDoc {
  /** The snapshot with every later update merged in: the document's full state. */
  state: Uint8Array
  sourceVersion: string | null
  schemaVersion: number
  /**
   * Identifies this history of the document. A rebuilt document gets a new
   * one, and a client holding a document from another lineage must discard it
   * rather than sync it, or both histories merge into duplicated content.
   */
  lineage: string
}

export async function loadCollabDoc(name: string, executor: DbExecutor = db): Promise<StoredCollabDoc | null> {
  const [row] = await executor.select().from(collabDoc).where(eq(collabDoc.name, name))
  if (!row) {
    return null
  }
  // One update row per query. An update replacing a large value is as large
  // as the value, and the embedded database builds a whole result in its wasm
  // memory: a handful of multi-megabyte rows in one result runs it out of
  // memory and takes every query down with it (see ROW_AT_A_TIME in
  // @opencroft/db's backup). Applied to a document one by one, and encoded
  // from it, overwritten values do not survive into the loaded state either.
  const doc = new Y.Doc()
  Y.applyUpdate(doc, decode(row.state))
  const ids = await executor
    .select({ id: collabDocUpdate.id })
    .from(collabDocUpdate)
    .where(eq(collabDocUpdate.name, name))
  for (const { id } of ids) {
    const [update] = await executor
      .select({ update: collabDocUpdate.update })
      .from(collabDocUpdate)
      .where(eq(collabDocUpdate.id, id))
    if (update) {
      Y.applyUpdate(doc, decode(update.update))
    }
  }
  return {
    state: Y.encodeStateAsUpdate(doc),
    sourceVersion: row.sourceVersion,
    schemaVersion: row.schemaVersion,
    lineage: row.lineage,
  }
}

/** Records one update. The document's row must exist. */
export async function appendCollabUpdate(name: string, update: Uint8Array): Promise<void> {
  await db.insert(collabDocUpdate).values({ name, update: encode(update) })
}

/**
 * Replaces the snapshot of an existing document with a state derived from it,
 * and drops the updates recorded before `coveredUntil`. Take `coveredUntil`
 * before encoding `state`: an update is recorded only after it is applied, so
 * every one recorded strictly earlier is in the state. Updates recorded later
 * stay, and one that is also in the state is harmless -- applying an update
 * twice changes nothing.
 */
export async function writeCollabSnapshot(
  name: string,
  snapshot: { state: Uint8Array; sourceVersion: string; coveredUntil: Date },
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .update(collabDoc)
    .set({ state: encode(snapshot.state), sourceVersion: snapshot.sourceVersion })
    .where(eq(collabDoc.name, name))
  await executor
    .delete(collabDocUpdate)
    .where(and(eq(collabDocUpdate.name, name), lt(collabDocUpdate.createdAt, snapshot.coveredUntil)))
}

/**
 * Starts a new lineage for `name`: whatever was stored under it, snapshot and
 * updates, is replaced by `state`. Returns the new lineage.
 */
export async function createCollabDoc(
  name: string,
  doc: { state: Uint8Array; sourceVersion: string; schemaVersion: number },
): Promise<string> {
  const lineage = crypto.randomUUID()
  await db.transaction(async (tx) => {
    await tx.delete(collabDoc).where(eq(collabDoc.name, name))
    await tx.insert(collabDoc).values({
      name,
      state: encode(doc.state),
      lineage,
      sourceVersion: doc.sourceVersion,
      schemaVersion: doc.schemaVersion,
    })
  })
  return lineage
}

export async function deleteCollabDoc(name: string): Promise<void> {
  await db.delete(collabDoc).where(eq(collabDoc.name, name))
}

/** Names of every stored document. */
export async function listCollabDocNames(): Promise<string[]> {
  return (await db.select({ name: collabDoc.name }).from(collabDoc)).map((r) => r.name)
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function decode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
}
