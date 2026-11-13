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

import { withReplacedValueNodes } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/replaced-value-nodes'
import {
  VALUE_NODE,
  valueNodeTypeOf,
  withSwitchCaseIds,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/value-nodes-shared'
import { normaliseTree, type TreeNode } from '@/app/_authed/(extension-runtime)/_frame-tree'
import type { MembershipChange } from '@/app/_authed/(extension-runtime)/_frame-tree-convert'
import { frameTest } from '@/app/_authed/(extension-runtime)/_server/frame-types'
import {
  graphsReadingChanges,
  graphsReadingMoved,
  graphsReadingRemoved,
} from '@/app/_authed/(extension-runtime)/_server/node-check-instance'
import { normaliseSubgraphs } from '@/app/_authed/(extension-runtime)/_wired-edges'
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
import { graphsRoutingTo } from '@/app/_authed/(space)/_server/route-dependents'
import {
  convertToTree,
  type GraphRef,
  getSpacesRegistry,
  readStoredGraph,
  removedNodeIds,
  serializeGraph,
} from '@/app/_authed/(space)/_server/store'
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
const RESOLVER_WRITE_ORIGIN: GraphWriteOrigin = { kind: 'system', name: 'graph-context-resolver' }
// A burst of edits announces `graph_updated` once.
const BROADCAST_DELAY_MS = 250
const RESOLVE_DELAY_MS = 150

const shared = globalThis as unknown as {
  __graphCollab?: {
    /** Document name -> lineage of the copy in memory. */
    lineages: Map<string, string>
    locks: Map<string, Promise<unknown>>
    timers: Map<string, ReturnType<typeof setTimeout>>
    /** Whether the registry already reports removed and moved graphs here. */
    registryWatched: boolean
  }
}
if (!shared.__graphCollab) {
  shared.__graphCollab = { lineages: new Map(), locks: new Map(), timers: new Map(), registryWatched: false }
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
    const whole = withWholeTree(next)
    const resolved = resolveContexts ? await resolveGraph(whole, checkedGraphOf(ref)) : whole
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
  if (!state.registryWatched) {
    state.registryWatched = true
    getSpacesRegistry().onGraphsRemoved(forgetGraphDocs)
    getSpacesRegistry().onGraphsRemoved((graphIds) => resolveGraphDocsLater(graphsReadingRemoved(graphIds)))
    getSpacesRegistry().onGraphAddressesChanged((graphIds) => resolveGraphDocsLater(graphsReadingMoved(graphIds)))
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

/**
 * Resolves every graph's contexts again and stores what changed. Runs at
 * startup, once the extensions and Apps that expose contexts are loaded. A
 * stored context is derived by the code that wrote it, and a graph resolves
 * again only when its document loads or changes, so a context an earlier build
 * stored (a router's route, a node's `__resolvedContexts`) can lack a field the
 * running code reads, such as the `credentialsScope` an SSH key is checked
 * against, until somebody opens or writes that graph. A graph that fails is
 * logged and resolves again at its next change.
 */
export async function refreshGraphContexts(): Promise<void> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const graphs = registry.listGraphs()
  let failed = 0
  for (const ref of graphs) {
    try {
      await mutateLiveGraph(registry.addressOf(ref), { kind: 'system', name: 'context refresh' }, () => undefined)
    } catch (err) {
      failed++
      console.error(`[graph-sync] ${registry.addressOf(ref)}: its contexts could not be resolved`, err)
    }
  }
  console.log(`[graph-sync] contexts of ${graphs.length - failed} of ${graphs.length} graphs resolved`)
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
    const resolveLater = () => later(`resolve:${name}`, RESOLVE_DELAY_MS, () => resolveContexts(name, document))
    document.on('update', (_update: Uint8Array, origin: unknown) => {
      project(graphId, document)
      if (origin !== RESOLVER_ORIGIN) {
        resolveLater()
      }
    })
    // Once as it loads too, so a node whose stored data its type's validator
    // finds a problem in shows that problem as soon as the graph is opened.
    resolveLater()
    document.on('destroy', () => state.lineages.delete(name))
  },

  async store(name, document) {
    const graphId = graphIdOfDocName(name) as string
    // Taken before the state is encoded: every update recorded until now is in it.
    const coveredUntil = new Date()
    const docState = Y.encodeStateAsUpdate(document)
    const data = serializeGraph(readGraphFromDoc(document))
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
    let sourceVersion = versionOf(row.data)
    const stored = await loadCollabDoc(name)
    if (stored && stored.sourceVersion === sourceVersion && stored.schemaVersion === GRAPH_DOC_SCHEMA_VERSION) {
      return stored
    }
    const json = readStoredGraph(row.data)
    // A document in step with the JSON, rebuilt for an older schema, is the
    // newer copy of the two: it holds every update recorded since its last
    // snapshot. The rebuild starts from it.
    const inStep = stored !== null && stored.sourceVersion === sourceVersion
    let graph = inStep ? graphOfState(stored.state) : json.graph
    if (!json.current) {
      // Converted once, and written back as the stored JSON, so the document
      // built here is in step with it.
      const converted = convertToTree(graph, await frameTest())
      graph = converted.graph
      logConversion(graphId, converted.changes)
      const data = serializeGraph(graph)
      await db.update(spaceGraph).set({ data }).where(eq(spaceGraph.id, graphId))
      sourceVersion = versionOf(data)
    }
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

function graphOfState(state: Uint8Array): GraphData {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return readGraphFromDoc(doc)
}

// What converting a graph to the frame tree changed, for whoever reads the log
// to check: each node whose frames differ from the ones whose area held it,
// such as a Docker Application in two overlapping Network frames, which keeps
// only the innermost.
function logConversion(graphId: string, changes: readonly MembershipChange[]): void {
  console.log(`[graph-sync] graph ${graphId}: converted to the frame tree; ${changes.length} node(s) changed frames`)
  const name = (f: { id: string; type?: string }) => `${f.id} (${f.type ?? 'no type'})`
  for (const change of changes) {
    console.log(
      `[graph-sync] graph ${graphId}: ${name({ id: change.nodeId, type: change.type })}` +
        (change.left.length > 0 ? ` left ${change.left.map(name).join(', ')}` : '') +
        (change.gained.length > 0 ? ` is now inside ${change.gained.map(name).join(', ')}` : ''),
    )
  }
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
  const registry = getSpacesRegistry()
  const ref = registry.graphById(graphId)
  if (!ref) {
    return
  }
  const before = ref.graph.graph
  ref.graph.graph = readGraphFromDoc(document)
  ref.graph.updatedAt = new Date()
  registry.nodesRemoved(removedNodeIds(before, ref.graph.graph))
  registry.graphChanged(ref)
  const changes = changedElementIds(before, ref.graph.graph)
  if (changes.nodeIds.length > 0) {
    resolveRoutingGraphs(graphId, changes.nodeIds)
  }
  resolveCheckingGraphs(graphId, before, ref.graph.graph, changes)
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

// `graph` with its frame tree made whole (see normaliseTree) and its
// subgraphs' invariants kept (see normaliseSubgraphs): unique port ids, edges
// only on ports that exist and on their side, no edge between two levels but
// a port edge, and each boundary given a place. Run on every server write,
// and on every change a client makes, where two people's concurrent drops can
// leave a member of a deleted frame or two frames inside each other, a port
// removed in one tab can still have an edge drawn to it in another, and a
// node moved into a subgraph in one tab can keep an edge another tab drew to
// it on the old level. Before contexts are resolved, so they never resolve
// through an edge that is dropped here. A Switch case written without an id
// (an agent's updateNodes) is given one here too (see `withSwitchCaseIds`),
// and a value node of a replaced type becomes a Value or a Convert (see
// `withReplacedValueNodes`).
function withWholeTree(graph: GraphData): GraphData {
  const current = withReplacedValueNodes(graph)
  const tree = normaliseTree(current.nodes as unknown as TreeNode[]) as unknown as GraphData['nodes']
  const nodes = withCaseIds(tree)
  return normaliseSubgraphs(nodes === current.nodes ? current : { ...current, nodes })
}

function withCaseIds(nodes: GraphData['nodes']): GraphData['nodes'] {
  let changed = false
  const next = nodes.map((node) => {
    const record = node as unknown as { type?: unknown; data?: Record<string, unknown> }
    if (valueNodeTypeOf(record.type) !== VALUE_NODE.switch || !record.data) {
      return node
    }
    const data = withSwitchCaseIds(record.data)
    if (data === record.data) {
      return node
    }
    changed = true
    return { ...node, data } as typeof node
  })
  return changed ? next : nodes
}

// Edges' contexts and nodes' data errors are derived from the graph, so a
// change made by a client has them resolved here, after it lands, under an
// origin of their own: not part of anybody's undo history, and redone when
// the change is undone.
async function resolveContexts(name: string, document: Document): Promise<void> {
  if (getCollabServer().documents.get(name) !== document) {
    return
  }
  try {
    const base = readGraphFromDoc(document)
    const ref = getSpacesRegistry().graphById(graphIdOfDocName(name) as string)
    const resolved = await resolveGraph(withWholeTree(base), ref ? checkedGraphOf(ref) : undefined)
    document.transact(() => applyGraphToDoc(document, resolved, { base }), RESOLVER_ORIGIN)
  } catch (err) {
    console.error(`[graph-sync] could not resolve contexts of ${name}`, err)
  }
}

// A Terminal Router in another graph carries the context of a node changed
// here, so that graph is resolved too, whether or not anyone has it open. Its
// own resolution is a change like any other and reaches the graphs routing to
// it in turn; a resolution that changes nothing writes nothing, which ends it.
function resolveRoutingGraphs(graphId: string, nodeIds: readonly string[]): void {
  const graphs = getSpacesRegistry()
    .listGraphs()
    .map((ref) => ({ id: ref.graph.id, graph: ref.graph.graph }))
  resolveGraphDocsLater(graphsRoutingTo(graphs, graphId, new Set(nodeIds)))
}

// A node check reads nodes of other graphs through its instance view (see
// node-check-instance), so a change to a type it read, or the deletion or new
// address of a graph holding one, checks its graph again, whether or not
// anyone has it open. That check is a change like any other; one that finds what the graph
// already holds writes nothing, which ends it.
function resolveCheckingGraphs(
  graphId: string,
  before: GraphData,
  after: GraphData,
  changes: { nodeIds: readonly string[]; edgeIds: readonly string[] },
): void {
  resolveGraphDocsLater(graphsReadingChanges(graphId, before, after, changes))
}

function resolveGraphDocsLater(graphIds: readonly string[]): void {
  for (const graphId of graphIds) {
    const name = graphDocName(graphId)
    later(`resolve:${name}`, RESOLVE_DELAY_MS, () => resolveGraphDoc(graphId, name))
  }
}

/** The graph as a check pass over it is told it: its id and address. */
function checkedGraphOf(ref: GraphRef): { id: string; address: string } {
  return { id: ref.graph.id, address: getSpacesRegistry().addressOf(ref) }
}

async function resolveGraphDoc(graphId: string, name: string): Promise<void> {
  if (!getSpacesRegistry().graphById(graphId)) {
    return
  }
  try {
    const connection = await getCollabServer().openDirectConnection(name, { origin: RESOLVER_WRITE_ORIGIN })
    try {
      await resolveContexts(name, connection.document as Document)
    } finally {
      await connection.disconnect({ unloadImmediately: false })
    }
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
