// A graph as a collaborative document: how the collaboration server loads,
// persists and projects a graph, and how server-side writers change one.
//
// A graph's Yjs document is its truth, and every writer changes a graph
// through it. The in-memory registry and `SpaceGraph.data` hold a projection
// of it, so every reader of a graph -- the runtime, the scheduler, the graph
// actions, the extension host -- reads plain JSON. The registry's copy is
// replaced after every change; the stored row is written with each snapshot.

import { createHash } from 'node:crypto'

import type { Document } from '@hocuspocus/server'
import { db, spaceGraph } from '@opencroft/db'
import { eq } from 'drizzle-orm'
import * as Y from 'yjs'

import {
  GRAPH_DOC_PREFIX,
  type GraphChangedMessage,
  type GraphWriteOrigin,
  graphDocName,
  graphIdOfDocName,
  type LiveGraphSession,
} from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import {
  applyGraphToDoc,
  changedElementIds,
  GRAPH_DOC_SCHEMA_VERSION,
  readGraphFromDoc,
  sameGraphContent,
} from '@/app/_authed/(space)/_lib/graph-doc'
import { resolveGraph } from '@/app/_authed/(space)/_server/resolve-graph'
import { type GraphRef, getSpacesRegistry, parseGraph } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { STALE_LINEAGE_REASON } from '@/lib/collab-protocol'
import { toastStore } from '@/lib/toast-store'
import {
  type CollabDocType,
  CollabRefusal,
  getCollabServer,
  registerCollabDocType,
} from '@/server/collab/collab-server'
import {
  createCollabDoc,
  deleteCollabDoc,
  listCollabDocNames,
  loadCollabDoc,
  writeCollabSnapshot,
} from '@/server/collab/collab-store'
import { keyedLock } from '@/server/collab/keyed-lock'

// The context resolver's own writes, which must not schedule another resolve.
const RESOLVER_ORIGIN = Symbol('graph-context-resolver')
// A burst of edits announces `graph_updated` once.
const BROADCAST_DELAY_MS = 250
const RESOLVE_DELAY_MS = 150

const shared = globalThis as unknown as {
  __graphCollab?: {
    /** Document name -> lineage of the copy in memory. */
    lineages: Map<string, string>
    locks: Map<string, Promise<unknown>>
    timers: Map<string, ReturnType<typeof setTimeout>>
    /** Whether the registry already reports removed graphs here. */
    removalsWatched: boolean
  }
}
if (!shared.__graphCollab) {
  shared.__graphCollab = { lineages: new Map(), locks: new Map(), timers: new Map(), removalsWatched: false }
}
const state = shared.__graphCollab
const withLock = keyedLock(state.locks)

/**
 * What a client needs to open a graph's document: its name, and the lineage
 * its copy must come from.
 */
export async function liveGraphSession(graphId: string): Promise<LiveGraphSession> {
  const docName = graphDocName(graphId)
  return { docName, lineage: await lineageOf(docName, graphId) }
}

/**
 * Changes a graph through its document. `mutate` edits a copy of the
 * graph as it is now; only what it changed is written, with edge contexts
 * resolved, in one transaction. A concurrent change elsewhere survives, and an
 * edit to an element deleted meanwhile is dropped. Clients are told who made
 * the change.
 *
 * `resolveContexts: false` writes the graph as `mutate` left it, for writers
 * of a node's own data; the resolver still runs on the document after any
 * change.
 */
export async function mutateLiveGraph<T>(
  address: string,
  origin: GraphWriteOrigin,
  mutate: (graph: GraphData, updatedAt: string) => T | Promise<T>,
  { resolveContexts = true }: { resolveContexts?: boolean } = {},
): Promise<T> {
  const ref = await resolveAddress(address)
  if (!ref) {
    throw new Error(`Graph not found: ${address}`)
  }
  registerGraphDocType()
  const connection = await getCollabServer().openDirectConnection(graphDocName(ref.graph.id), { origin })
  try {
    const document = connection.document as Document
    const base = readGraphFromDoc(document)
    const next = structuredClone(base)
    const result = await mutate(next, ref.graph.updatedAt.toISOString())
    const resolved = resolveContexts ? await resolveGraph(next) : next
    await connection.transact((doc) => applyGraphToDoc(doc, resolved, { base }))
    announce(document, origin, base, resolved)
    return result
  } finally {
    // The debounced store, not an immediate one: a burst of server writes
    // (a streaming log, a scheduler run) becomes one snapshot.
    await connection.disconnect({ unloadImmediately: false })
  }
}

/**
 * Makes the collaboration server serve graphs. Startup calls it so clients are
 * served from the first request; every server-side write calls it too, since
 * a write is served by the same server. Repeat calls change nothing.
 */
export function registerGraphDocType(): void {
  registerCollabDocType(graphDocType)
  if (!state.removalsWatched) {
    state.removalsWatched = true
    getSpacesRegistry().onGraphsRemoved(forgetGraphDocs)
  }
}

/**
 * Brings every graph's stored document in step with its stored JSON, creating
 * or rebuilding where needed, and drops documents of graphs that no longer
 * exist. Runs at startup. A graph whose document cannot be prepared now is
 * prepared again when it is first opened or written.
 */
export async function prepareLiveGraphs(): Promise<void> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const graphs = registry.listGraphs()
  let failed = 0
  for (const ref of graphs) {
    try {
      projectState(ref, (await prepareGraphDoc(ref.graph.id)).state)
    } catch (err) {
      failed++
      console.error(`[graph-sync] ${registry.addressOf(ref)}: could not prepare its document`, err)
    }
  }
  const ids = new Set(graphs.map((ref) => ref.graph.id))
  for (const name of await listCollabDocNames()) {
    const graphId = graphIdOfDocName(name)
    if (graphId !== null && !ids.has(graphId)) {
      await deleteCollabDoc(name)
    }
  }
  console.log(`[graph-sync] ${graphs.length - failed} of ${graphs.length} graph documents prepared`)
}

export const graphDocType: CollabDocType = {
  prefix: GRAPH_DOC_PREFIX,

  async authorize(name, _user, token) {
    if (token !== (await lineageOf(name, graphIdOfDocName(name) as string))) {
      throw new CollabRefusal(STALE_LINEAGE_REASON)
    }
  },

  async load(name) {
    const prepared = await prepareGraphDoc(graphIdOfDocName(name) as string)
    state.lineages.set(name, prepared.lineage)
    return prepared.state
  },

  loaded(name, document) {
    const graphId = graphIdOfDocName(name) as string
    document.on('update', (_update: Uint8Array, origin: unknown) => {
      project(graphId, document)
      if (origin !== RESOLVER_ORIGIN) {
        later(`resolve:${name}`, RESOLVE_DELAY_MS, () => resolveContexts(name, document))
      }
    })
    document.on('destroy', () => state.lineages.delete(name))
  },

  async store(name, document) {
    const graphId = graphIdOfDocName(name) as string
    // Taken before the state is encoded: every update recorded until now is in it.
    const coveredUntil = new Date()
    const docState = Y.encodeStateAsUpdate(document)
    const data = JSON.stringify(readGraphFromDoc(document))
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(spaceGraph)
        .set({ data })
        .where(eq(spaceGraph.id, graphId))
        .returning({ id: spaceGraph.id })
      if (row) {
        await writeCollabSnapshot(name, { state: docState, sourceVersion: versionOf(data), coveredUntil }, tx)
      }
    })
  },
}

// The document's stored state, in step with the graph's stored JSON. A
// document whose recorded JSON version differs was left behind by writes made
// without it and is rebuilt from the JSON, as is a missing one; a rebuilt
// document starts a new lineage. One graph at a time: two builders racing
// would start two lineages.
function prepareGraphDoc(graphId: string): Promise<{ state: Uint8Array; lineage: string }> {
  return withLock(graphId, async () => {
    const name = graphDocName(graphId)
    const [row] = await db.select({ data: spaceGraph.data }).from(spaceGraph).where(eq(spaceGraph.id, graphId))
    if (!row) {
      throw new Error(`Graph not found: ${graphId}`)
    }
    const sourceVersion = versionOf(row.data)
    const stored = await loadCollabDoc(name)
    if (stored && stored.sourceVersion === sourceVersion && stored.schemaVersion === GRAPH_DOC_SCHEMA_VERSION) {
      return stored
    }
    const graph = parseGraph(row.data)
    const doc = new Y.Doc()
    applyGraphToDoc(doc, graph)
    const built = readGraphFromDoc(doc)
    if (!sameGraphContent(built, graph)) {
      // The document addresses elements by id; one without a string id, or a
      // repeat of an id, has no place in it. Its first snapshot writes the
      // graph back without them.
      console.error(
        `[graph-sync] graph ${graphId}: its document leaves out ${graph.nodes.length - built.nodes.length} nodes and ` +
          `${graph.edges.length - built.edges.length} edges of its stored JSON`,
      )
    }
    const docState = Y.encodeStateAsUpdate(doc)
    const lineage = await createCollabDoc(name, {
      state: docState,
      sourceVersion,
      schemaVersion: GRAPH_DOC_SCHEMA_VERSION,
    })
    console.log(`[graph-sync] ${stored ? 'rebuilt' : 'created'} the document of graph ${graphId}`)
    return { state: docState, lineage }
  })
}

async function lineageOf(docName: string, graphId: string): Promise<string> {
  return state.lineages.get(docName) ?? (await prepareGraphDoc(graphId)).lineage
}

function forgetGraphDocs(graphIds: string[]): void {
  for (const graphId of graphIds) {
    const name = graphDocName(graphId)
    getCollabServer().closeConnections(name)
    state.lineages.delete(name)
    deleteCollabDoc(name).catch((err) => console.error(`[graph-sync] could not delete the document ${name}`, err))
  }
}

function project(graphId: string, document: Document): void {
  const ref = getSpacesRegistry().graphById(graphId)
  if (!ref) {
    return
  }
  ref.graph.graph = readGraphFromDoc(document)
  ref.graph.updatedAt = new Date()
  later(`broadcast:${graphId}`, BROADCAST_DELAY_MS, () =>
    toastStore.broadcast({ type: 'graph_updated', spaceId: ref.space.slug }),
  )
}

// A stored state can be ahead of the stored JSON: updates recorded after the
// last snapshot are applied on load but not yet written to `SpaceGraph.data`.
function projectState(ref: GraphRef, docState: Uint8Array): void {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, docState)
  const graph = readGraphFromDoc(doc)
  if (!sameGraphContent(graph, ref.graph.graph)) {
    ref.graph.graph = graph
    ref.graph.updatedAt = new Date()
  }
}

// Edges' contexts are derived from the graph, so a change made by a client
// has them resolved here, after it lands, under an origin of their own: not
// part of anybody's undo history, and redone when the change is undone.
async function resolveContexts(name: string, document: Document): Promise<void> {
  if (getCollabServer().documents.get(name) !== document) {
    return
  }
  try {
    const base = readGraphFromDoc(document)
    const resolved = await resolveGraph(base)
    document.transact(() => applyGraphToDoc(document, resolved, { base }), RESOLVER_ORIGIN)
  } catch (err) {
    console.error(`[graph-sync] could not resolve contexts of ${name}`, err)
  }
}

function announce(document: Document, origin: GraphWriteOrigin, before: GraphData, after: GraphData): void {
  const ids = changedElementIds(before, after)
  if (ids.nodeIds.length === 0 && ids.edgeIds.length === 0) {
    return
  }
  const message: GraphChangedMessage = { type: 'graph-changed', origin, ...ids }
  document.broadcastStateless(JSON.stringify(message))
}

async function resolveAddress(address: string): Promise<GraphRef | null> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  return registry.resolveGraph(address)
}

function versionOf(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function later(key: string, delay: number, run: () => unknown): void {
  clearTimeout(state.timers.get(key))
  state.timers.set(
    key,
    setTimeout(() => {
      state.timers.delete(key)
      void run()
    }, delay),
  )
}
