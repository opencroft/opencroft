// Markdown documents several people edit at once, as a collaborative document
// type. Whoever stores a kind of document -- an extension, by its own rules --
// registers that storage; the server holds the shared copy while anyone has
// the document open, and writes its markdown back to the storage.
//
// While a document is open its Yjs document is the truth and the stored
// markdown its projection, written with each snapshot. Both directions go
// through the editor's own converter and schema, so the document every editor
// binds to is the one the server builds, and the markdown it writes is the
// markdown an editor would.
//
// Opening a document does not rewrite it: a document nobody has changed since
// it was read writes back the very text it was read from, and only an edit
// makes it the converter's writing of the document. A change made from outside
// an editor to such a document is kept exactly as it was made.

import { createHash } from 'node:crypto'

import type { Document } from '@hocuspocus/server'
import {
  absolutePositionToRelativePosition,
  initProseMirrorDoc,
  prosemirrorJSONToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProsemirrorJSON,
} from '@tiptap/y-tiptap'
import { markdownConverter, markdownSchema } from 'agent-chat/markdown-schema'
import * as Y from 'yjs'

import { STALE_LINEAGE_REASON } from '@/lib/collab-protocol'
import { changedRange } from '@/lib/markdown-doc-change'
import {
  MARKDOWN_DOC_FIELD,
  MARKDOWN_DOC_PREFIX,
  type MarkdownEditMessage,
  type MarkdownEditOrigin,
  markdownDocName,
  parseMarkdownDocName,
} from '@/lib/markdown-doc-protocol'
import {
  type CollabDocType,
  CollabRefusal,
  type CollabUser,
  getCollabServer,
  registerCollabDocType,
} from '@/server/collab/collab-server'
import { createCollabDoc, deleteCollabDoc, loadCollabDoc, writeCollabSnapshot } from '@/server/collab/collab-store'
import { keyedLock } from '@/server/collab/keyed-lock'

/** Where one kind of markdown document is stored, keyed by whatever its owner keys them by. */
export interface MarkdownDocStorage {
  /** The document's markdown as stored; null when there is no such document. */
  read(key: string): Promise<string | null>
  /** Stores the document's markdown. */
  write(key: string, markdown: string): Promise<void>
  /** Whether a signed-in person may open the document; when absent, everyone signed in may. */
  authorize?(key: string, user: CollabUser): Promise<boolean> | boolean
}

/**
 * Bumped when the editor's schema changes in a way a stored document cannot
 * follow: every stored document is then rebuilt from its stored markdown.
 */
export const MARKDOWN_DOC_SCHEMA_VERSION = 1

/** The markdown a document was last read from or written as, and how the document built from it writes. */
interface Base {
  markdown: string
  written: string
}

const shared = globalThis as unknown as {
  __markdownDocs?: {
    storages: Map<string, MarkdownDocStorage>
    /** Document name -> lineage of the copy in memory. */
    lineages: Map<string, string>
    /** Document name -> the base of the copy in memory. */
    bases: Map<string, Base>
    /** Documents being dropped without storing what they hold. */
    dropping: Set<string>
    /** Owner -> settles when that owner's documents may be opened again. */
    closed: Map<string, Promise<void>>
    locks: Map<string, Promise<unknown>>
  }
}
if (!shared.__markdownDocs) {
  shared.__markdownDocs = {
    storages: new Map(),
    lineages: new Map(),
    bases: new Map(),
    dropping: new Set(),
    closed: new Map(),
    locks: new Map(),
  }
}
const state = shared.__markdownDocs
// One document at a time: building a document and changing its storage must
// not interleave, and two builders racing would start two lineages.
const withLock = keyedLock(state.locks)

/** Makes the collaboration server serve markdown documents. Once per process, at startup. */
export function registerMarkdownDocType(): void {
  registerCollabDocType(markdownDocType)
}

/** Serves the documents of `owner` -- an extension and a kind of document -- from `storage`. */
export function registerMarkdownDocs(owner: string, storage: MarkdownDocStorage): void {
  if (owner.includes(':')) {
    throw new Error(`A markdown document owner holds no colon: "${owner}"`)
  }
  state.storages.set(owner, storage)
}

function storageOf(name: string): { owner: string; key: string; storage: MarkdownDocStorage } {
  const parsed = parseMarkdownDocName(name)
  const storage = parsed && state.storages.get(parsed.owner)
  if (!parsed || !storage) {
    throw new Error(`No markdown documents are served for "${name}"`)
  }
  return { ...parsed, storage }
}

function fragmentOf(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(MARKDOWN_DOC_FIELD)
}

function writtenOf(doc: Y.Doc): string {
  return markdownConverter().serialize(yXmlFragmentToProsemirrorJSON(fragmentOf(doc)))
}

function build(markdown: string): Y.Doc {
  const doc = new Y.Doc()
  prosemirrorJSONToYXmlFragment(markdownSchema(), markdownConverter().parse(markdown), fragmentOf(doc))
  return doc
}

function versionOf(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex')
}

/** The document's markdown as it stands: the stored text itself, while nobody has changed the document. */
function markdownOf(name: string, doc: Y.Doc): string {
  const written = writtenOf(doc)
  const base = state.bases.get(name)
  return base && written === base.written ? base.markdown : written
}

/**
 * Waits while `owner`'s documents are closed for a change to their storage --
 * and for every change queued behind it. Anything that opens a document or
 * hands out its lineage waits here first: a connection let in while its
 * document is being closed would hold the document open, and the close
 * would fail.
 */
async function untilOpen(owner: string): Promise<void> {
  for (let closed = state.closed.get(owner); closed; closed = state.closed.get(owner)) {
    await closed
  }
}

/**
 * The document's stored state, in step with its stored markdown. A stored
 * document recorded against other markdown -- the markdown changed without
 * it -- is rebuilt from the markdown under a new lineage, as is a missing one.
 * Null when there is no such document. Waits while the owner's documents are
 * closed for a change to their storage.
 */
async function prepare(name: string): Promise<{ state: Uint8Array; lineage: string; markdown: string } | null> {
  const { owner, key, storage } = storageOf(name)
  await untilOpen(owner)
  return withLock(name, async () => {
    const markdown = await storage.read(key)
    if (markdown === null) {
      return null
    }
    const sourceVersion = versionOf(markdown)
    const stored = await loadCollabDoc(name)
    if (stored && stored.sourceVersion === sourceVersion && stored.schemaVersion === MARKDOWN_DOC_SCHEMA_VERSION) {
      return { state: stored.state, lineage: stored.lineage, markdown }
    }
    const docState = Y.encodeStateAsUpdate(build(markdown))
    const lineage = await createCollabDoc(name, {
      state: docState,
      sourceVersion,
      schemaVersion: MARKDOWN_DOC_SCHEMA_VERSION,
    })
    return { state: docState, lineage, markdown }
  })
}

/** Writes `markdown` -- the document's -- to its storage when it differs from what is stored, and snapshots the document. */
async function store(name: string, document: Y.Doc, markdown: string): Promise<void> {
  const { key, storage } = storageOf(name)
  // Taken before the state is encoded: every update recorded until now is in it.
  const coveredUntil = new Date()
  const docState = Y.encodeStateAsUpdate(document)
  if (markdown !== state.bases.get(name)?.markdown) {
    await storage.write(key, markdown)
    state.bases.set(name, { markdown, written: writtenOf(document) })
  }
  await writeCollabSnapshot(name, { state: docState, sourceVersion: versionOf(markdown), coveredUntil })
}

export const markdownDocType: CollabDocType = {
  prefix: MARKDOWN_DOC_PREFIX,

  async authorize(name, user, token) {
    const { owner, key, storage } = storageOf(name)
    if (storage.authorize && !(await storage.authorize(key, user))) {
      throw new Error('Not allowed to open this document')
    }
    // Before the lineage is read: while the document is being closed it still
    // holds the old one, and the connection would be let in onto it.
    await untilOpen(owner)
    const lineage = state.lineages.get(name) ?? (await prepare(name))?.lineage
    if (!lineage) {
      throw new Error('No such document')
    }
    if (token !== lineage) {
      throw new CollabRefusal(STALE_LINEAGE_REASON)
    }
  },

  async load(name) {
    const prepared = await prepare(name)
    if (!prepared) {
      throw new Error('No such document')
    }
    state.lineages.set(name, prepared.lineage)
    state.bases.set(name, { markdown: prepared.markdown, written: writtenOf(build(prepared.markdown)) })
    return prepared.state
  },

  loaded(name, document) {
    document.on('destroy', () => {
      state.lineages.delete(name)
      state.bases.delete(name)
    })
  },

  async store(name, document) {
    // Only the copy the server holds, and only while it is not being dropped:
    // closing a document can still ask to store it after it was closed.
    if (!state.dropping.has(name) && getCollabServer().documents.get(name) === document) {
      await store(name, document, markdownOf(name, document))
    }
  },
}

/** What a client needs to open a document: its lineage. Null when there is no such document. */
export async function markdownDocLineage(name: string, user: CollabUser): Promise<string | null> {
  const { owner, key, storage } = storageOf(name)
  if (storage.authorize && !(await storage.authorize(key, user))) {
    return null
  }
  await untilOpen(owner)
  return state.lineages.get(name) ?? (await prepare(name))?.lineage ?? null
}

/** A document's markdown as it stands: the open copy's when it is open, the stored markdown otherwise. */
export async function readMarkdownDoc(owner: string, key: string): Promise<string | null> {
  const name = markdownDocName(owner, key)
  const document = getCollabServer().documents.get(name)
  return document ? markdownOf(name, document) : storageOf(name).storage.read(key)
}

/**
 * Changes a document's markdown from outside an editor, as `origin`: `change`
 * is handed the markdown as it stands and returns the markdown it should be.
 *
 * An open document is changed in place -- only what `change` changed, in one
 * transaction, so what others type meanwhile survives -- and every editor is
 * told who changed what. The change is stored before this returns. A document
 * nobody has open is changed in its storage alone. Returns the new markdown.
 */
export async function editMarkdownDoc(
  owner: string,
  key: string,
  origin: MarkdownEditOrigin,
  change: (markdown: string) => string,
): Promise<string> {
  const name = markdownDocName(owner, key)
  const { storage } = storageOf(name)
  await untilOpen(owner)
  const server = getCollabServer()
  // Under the lock a load takes, so no document is built from the markdown
  // this replaces; a document already loading is changed once it is open.
  const unopened = await withLock(name, async () => {
    if (server.documents.has(name) || server.loadingDocuments.has(name)) {
      return undefined
    }
    const markdown = await storage.read(key)
    if (markdown === null) {
      throw new Error(`No such document: ${key}`)
    }
    const next = change(markdown)
    if (next !== markdown) {
      await storage.write(key, next)
    }
    return next
  })
  return unopened ?? editOpenDoc(name, origin, change)
}

async function editOpenDoc(
  name: string,
  origin: MarkdownEditOrigin,
  change: (markdown: string) => string,
): Promise<string> {
  const connection = await getCollabServer().openDirectConnection(name, { origin })
  try {
    const document = connection.document as Document
    const before = markdownOf(name, document)
    const next = change(before)
    if (next === before) {
      return next
    }
    const unchanged = before === state.bases.get(name)?.markdown
    const schema = markdownSchema()
    const beforeNode = schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(fragmentOf(document)))
    const nextNode = schema.nodeFromJSON(markdownConverter().parse(next))
    await connection.transact((doc) =>
      updateYFragment(doc, fragmentOf(doc), nextNode, { mapping: new Map(), isOMark: new Map() }),
    )
    announce(document, origin, beforeNode)
    // A document nobody had changed keeps the markdown as it was given.
    await store(name, document, unchanged ? next : markdownOf(name, document))
    return next
  } finally {
    await connection.disconnect()
  }
}

type ProseMirrorNode = ReturnType<ReturnType<typeof markdownSchema>['nodeFromJSON']>

/** Tells every editor of `document` that `origin` just changed it, and where the new content is. */
function announce(document: Document, origin: MarkdownEditOrigin, before: ProseMirrorNode): void {
  const fragment = fragmentOf(document)
  const { doc: after, mapping } = initProseMirrorDoc(fragment, markdownSchema())
  const range = changedRange(before, after)
  if (!range) {
    return
  }
  const message: MarkdownEditMessage = {
    type: 'markdown-edit',
    origin,
    from: Y.relativePositionToJSON(absolutePositionToRelativePosition(range.from, fragment, mapping)),
    to: Y.relativePositionToJSON(absolutePositionToRelativePosition(range.endAfter, fragment, mapping)),
  }
  document.broadcastStateless(JSON.stringify(message))
}

/** Stores now what the open documents of `owner` hold -- or only `key`'s -- ignoring the debounce. */
export async function flushMarkdownDocs(owner: string, key?: string): Promise<void> {
  for (const [name, document] of getCollabServer().documents) {
    const parsed = parseMarkdownDocName(name)
    if (parsed?.owner === owner && (key === undefined || parsed.key === key)) {
      await markdownDocType.store(name, document)
    }
  }
}

// How long a document being closed may take to let go of its last connection
// -- a change from outside an editor finishing -- before closing gives up.
const CLOSE_ATTEMPTS = 100
const CLOSE_WAIT_MS = 20

/**
 * Closes every connection to a document and takes it out of memory. The
 * server will not unload a document while a store of it is pending, and one
 * is pending after any keystroke, so that store is run now -- `store` skips a
 * document being dropped -- before unloading. Throws when the document is
 * still open after that, rather than letting a change to its storage run
 * under a copy that would write itself back.
 *
 * Reaches into Hocuspocus 4.7's internals: its `debouncer` and the
 * `onStoreDocument-<name>` key it debounces a store under. If an upgrade
 * renames either, the pending store is no longer run, the unload keeps being
 * refused, and this throws -- loudly, not by writing a dropped copy back.
 */
async function closeDocument(name: string, document: Document): Promise<void> {
  const server = getCollabServer()
  server.closeConnections(name)
  const pendingStore = `onStoreDocument-${name}`
  for (let attempt = 0; server.documents.get(name) === document; attempt++) {
    if (attempt === CLOSE_ATTEMPTS) {
      throw new Error(`Could not close the document ${name}`)
    }
    if (server.debouncer.isDebounced(pendingStore)) {
      await server.debouncer.executeNow(pendingStore)
    }
    await server.unloadDocument(document)
    if (server.documents.get(name) === document) {
      await new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS))
    }
  }
}

/**
 * Runs `change` -- a change to the storage of `owner`'s documents, or of the
 * ones `keys` names -- while none of them is open. Each open one is stored
 * first, unless `discard` drops what it holds, and closed; editors reconnect
 * once `change` is done, to the stored markdown as `change` left it. A document
 * whose markdown `change` changed is rebuilt from it, and editors holding the
 * old copy open a fresh one. `discard` also forgets the stored documents of
 * `keys`, so they are rebuilt even where their markdown did not change.
 */
export async function whileMarkdownDocsClosed<T>(
  owner: string,
  keys: string[] | null,
  change: () => Promise<T>,
  { discard = false }: { discard?: boolean } = {},
): Promise<T> {
  const previous = state.closed.get(owner)
  let reopen = () => {}
  const gate = new Promise<void>((resolve) => {
    reopen = resolve
  })
  // Chained, so two changes to one owner's storage run one after the other.
  const closed = (previous ?? Promise.resolve()).then(() => gate)
  state.closed.set(owner, closed)
  const dropped: string[] = []
  try {
    await previous
    const server = getCollabServer()
    for (const [name, document] of [...server.documents]) {
      const parsed = parseMarkdownDocName(name)
      if (parsed?.owner !== owner || (keys && !keys.includes(parsed.key))) {
        continue
      }
      if (!discard) {
        await markdownDocType.store(name, document)
      }
      state.dropping.add(name)
      dropped.push(name)
      await closeDocument(name, document)
    }
    const result = await change()
    if (discard) {
      for (const key of keys ?? []) {
        await deleteCollabDoc(markdownDocName(owner, key))
      }
    }
    return result
  } finally {
    for (const name of dropped) {
      state.dropping.delete(name)
    }
    if (state.closed.get(owner) === closed) {
      state.closed.delete(owner)
    }
    reopen()
  }
}
