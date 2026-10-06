// The collaboration server: one Hocuspocus instance inside the app process,
// reached over /api/ws/collab and, in-process, through direct connections.
//
// It is generic. What a document is, where its plain form lives and who may
// open it is decided by the document type registered for its name's prefix
// (`<prefix>:<rest>`); this file only runs the sync, records every change
// and asks the type to load and store.

import { type Document, Hocuspocus } from '@hocuspocus/server'
import { getSessionUser } from '@opencroft/auth/server'
import * as Y from 'yjs'

import { appendCollabUpdate } from '@/server/collab/collab-store'

export interface CollabUser {
  id: string
  name: string
}

/** Context carried by a connection; direct connections set `origin` instead of `user`. */
export interface CollabContext {
  user?: CollabUser
  origin?: unknown
}

/**
 * A refusal whose reason reaches the client. Hocuspocus sends a refused
 * connection the error's `reason`, and a plain error has none, so the client
 * would only ever learn "permission-denied".
 *
 * A refusal is part of the protocol -- a stale copy is told so, and opens a
 * fresh one -- not a fault, so it carries no message: Hocuspocus logs a
 * failing hook's message as an error, which put one in the console on every
 * discard.
 */
export class CollabRefusal extends Error {
  constructor(readonly reason: string) {
    super()
  }
}

export interface CollabDocType {
  /** The name prefix this type owns, without the colon. */
  prefix: string
  /**
   * Refuses (by throwing) a user who may not open the document, or a client
   * whose `token` names a lineage other than the stored one. Throw a
   * CollabRefusal for a refusal the client must be able to tell apart.
   */
  authorize(name: string, user: CollabUser, token: string): Promise<void>
  /** The document's full state; the type creates it when nothing is stored yet. */
  load(name: string): Promise<Uint8Array>
  /** Called once the document is in memory, before any connection syncs it. */
  loaded?(name: string, document: Document): void
  /** Persists the document: its snapshot and, where the type keeps one, its plain form. */
  store(name: string, document: Document): Promise<void>
}

const globalForCollab = globalThis as unknown as {
  __collabTypes?: Map<string, CollabDocType>
  __collabServer?: Hocuspocus<CollabContext>
}

if (!globalForCollab.__collabTypes) {
  globalForCollab.__collabTypes = new Map()
}
const types = globalForCollab.__collabTypes

export function registerCollabDocType(type: CollabDocType): void {
  types.set(type.prefix, type)
}

function typeOf(name: string): CollabDocType {
  const type = types.get(name.slice(0, name.indexOf(':')))
  if (!type) {
    throw new Error(`No collaborative document type for "${name}"`)
  }
  return type
}

// How long after a document's last change its changes are recorded, and the
// longest a change waits to be recorded while changes keep coming.
const RECORD_DELAY_MS = 200
const RECORD_MAX_WAIT_MS = 1_000

interface RecordState {
  /** The document's state vector as last recorded: what the stored rows already hold. */
  recorded: Uint8Array
  timer?: ReturnType<typeof setTimeout>
  firstPendingAt?: number
}

// Changes are recorded as deltas from the state last recorded, encoded from
// the live document at most once per window -- not one row per update. An
// update replacing a large value is as large as the value, and a value
// rewritten on every change (a streaming log) would otherwise leave one such
// row per change until the next snapshot. Encoded from the document, a burst
// of rewrites is one row holding only the latest value.
const recording = new WeakMap<Document, RecordState>()

function scheduleRecord(name: string, document: Document): void {
  const state = recording.get(document)
  if (!state) {
    return
  }
  const now = Date.now()
  state.firstPendingAt ??= now
  clearTimeout(state.timer)
  const wait = Math.min(RECORD_DELAY_MS, Math.max(0, state.firstPendingAt + RECORD_MAX_WAIT_MS - now))
  state.timer = setTimeout(() => void recordChanges(name, document), wait)
}

async function recordChanges(name: string, document: Document): Promise<void> {
  const state = recording.get(document)
  // A document unloaded meanwhile was stored whole as it went.
  if (!state || globalForCollab.__collabServer?.documents.get(name) !== document) {
    return
  }
  state.timer = undefined
  state.firstPendingAt = undefined
  const update = Y.encodeStateAsUpdate(document, state.recorded)
  state.recorded = Y.encodeStateVector(document)
  try {
    await appendCollabUpdate(name, update)
  } catch (err) {
    console.error(`[collab] could not record changes of ${name}; the next snapshot holds them`, err)
  }
}

export function getCollabServer(): Hocuspocus<CollabContext> {
  globalForCollab.__collabServer ??= new Hocuspocus<CollabContext>({
    quiet: true,
    // A snapshot every 2 s of activity at most, and at least every 10 s while
    // edits keep coming; changes in between are recorded within a second.
    debounce: 2_000,
    maxDebounce: 10_000,
    async onAuthenticate({ documentName, request, token }) {
      const user = await getSessionUser(request)
      if (!user) {
        throw new Error('Not signed in')
      }
      const collabUser = { id: user.id, name: user.name }
      await typeOf(documentName).authorize(documentName, collabUser, token)
      return { user: collabUser }
    },
    async onLoadDocument({ documentName, document }) {
      const state = await typeOf(documentName).load(documentName)
      Y.applyUpdate(document, state)
      return document
    },
    async afterLoadDocument({ documentName, document }) {
      recording.set(document, { recorded: Y.encodeStateVector(document) })
      typeOf(documentName).loaded?.(documentName, document)
    },
    async onChange({ documentName, document }) {
      scheduleRecord(documentName, document)
    },
    async onStoreDocument({ documentName, document }) {
      await typeOf(documentName).store(documentName, document)
    },
  })
  return globalForCollab.__collabServer
}

/** Stores every document in memory now, ignoring the debounce. For shutdown. */
export async function storeAllCollabDocs(): Promise<void> {
  const server = globalForCollab.__collabServer
  if (!server) {
    return
  }
  for (const [name, document] of server.documents) {
    await typeOf(name).store(name, document)
  }
}
