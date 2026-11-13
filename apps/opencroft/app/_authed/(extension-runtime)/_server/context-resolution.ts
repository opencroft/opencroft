// The resolution itself, kept free of the extension runtime so its ORDER can
// be tested with a fake exposeOutput. Loading the runtime opens the database.
import { isDeepStrictEqual } from 'node:util'

import {
  AWAITING_RUN_KEY as AWAITING_KEY,
  awaitingRunOf,
  RESOLVED_CONTEXTS_KEY as CONTEXT_KEY,
  type EnumCasesOf,
  NO_ENUMS,
  type ResolvedInputEntry as ResolvedContextEntry,
  UNRESOLVED_INPUTS_KEY as UNRESOLVED_KEY,
} from '@opencroft/core/values'
import type { ExposeOutput } from '@opencroft/server/actions'

import type { TerminalRoute } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/terminal-router-shared'
import { TERMINAL_ROUTER_NODE_TYPE } from '@/app/_authed/(extension-runtime)/_core-types'
import { sourceHandleOf } from '@/app/_authed/(extension-runtime)/_declared-handles'
import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { feedingEdges } from '@/app/_authed/(extension-runtime)/_input-edges'
import type { GraphEdgeRecord, GraphNodeRecord, GraphSnapshot } from '@/app/_authed/(extension-runtime)/_server/host'
import type { NodeTypeHandles } from '@/app/_authed/(extension-runtime)/_server/node-handles'
import { wiredEdges } from '@/app/_authed/(extension-runtime)/_wired-edges'

export interface ContextResolverDeps {
  nodeTypeToExtension: Map<string, NodeTypeHandles>
  exposeOutputOf(extensionId: string): Promise<ExposeOutput | undefined>
  /** The enums the installed extensions declare, handed to every `exposeOutput`. */
  enumCasesOf: EnumCasesOf
  /** A "node-id/handle-id" terminal source's context, as terminal.getContext resolves it; throws when it does not resolve. */
  resolveTerminalTarget(target: string): Promise<unknown>
  /**
   * The event `nodeId` dispatched in the run this resolution serves, handed
   * to its `exposeOutput` as `run`. Absent outside a run: every run-time
   * output then exposes nothing, and what it feeds is listed under
   * `__awaitingRun`.
   */
  runEventOf?(nodeId: string): unknown
}

/** What resolving one wired input gave: its context, or nothing, and whether that nothing waits for a run. */
type InputState = ResolvedContextEntry | 'unresolved' | 'awaiting'

/**
 * Calls exposeOutput on every edge's source node and writes the resolved
 * context into the target node's data, replacing whatever was stored there.
 *
 * A source's output can depend on one of that same node's inputs: an
 * application node builds its per-container terminal context from its own
 * resolved docker input, and a docker node exposes its own `ctx-in` (falling
 * back to the local machine while that input is absent). Edges are stored in
 * creation order, which need not be dependency order: re-wiring a docker
 * node's input makes that edge the newest, so every application edge before it
 * is read while the docker node still lacks its input. A source is therefore
 * read again whenever one of its inputs changes after it was read, until no
 * input changes; each read sees the data written so far.
 *
 * Only the edge that feeds each handle is resolved (see `feedingEdges`), so
 * read order never decides which of several edges a handle ends up with.
 *
 * A wired input whose source exposes nothing is listed by handle id under
 * `__unresolvedInputs`, from the start of the run until its context is
 * written. A source that falls back to a default while an input is absent can
 * tell an input nobody wired from one whose source is gone, at every read.
 * Of those, an input that has no value because nothing runs is also listed
 * under `__awaitingRun`: fed by a run-time output (`runtime: true`) with no
 * run event, or by a source that exposes nothing while one of its own inputs
 * awaits a run.
 */
export async function resolveContexts(graph: GraphSnapshot, deps: ContextResolverDeps): Promise<GraphSnapshot> {
  const nodesById = new Map<string, GraphNodeRecord>()
  for (const node of graph.nodes) {
    const { [CONTEXT_KEY]: _, [UNRESOLVED_KEY]: __, [AWAITING_KEY]: ___, ...data } = node.data
    nodesById.set(node.id, { ...node, data })
  }
  for (const node of nodesById.values()) {
    if (node.type === TERMINAL_ROUTER_NODE_TYPE) {
      nodesById.set(node.id, { ...node, data: await refreshRoutes(node.data, deps) })
    }
  }

  // Through subgraph ports to the real sources (see `wiredEdges`): a node
  // inside a subgraph resolves what the same wiring would give it outside one.
  const edges = feedingEdges(wiredEdges(graph)).filter((edge) => nodesById.has(edge.target))
  // Every wired input is unresolved until its context is written, so a source
  // read before then is told so rather than finding the input merely absent.
  for (const edge of edges) {
    const target = nodesById.get(edge.target) as GraphNodeRecord
    nodesById.set(target.id, withInput(target, edge.targetHandle, 'unresolved'))
  }
  // Counted in reads: when each edge's source was last read, and when each
  // node's inputs last changed. exposeOutput sees only its node's data, so a
  // source whose inputs did not change since an edge read it answers the same.
  let reads = 0
  const readAt = new Map<GraphEdgeRecord, number>()
  const inputsChangedAt = new Map<string, number>()
  const final = new Set<GraphEdgeRecord>()
  let pending = edges
  // In a cycle of contexts each read can change the next; a pass per edge is
  // more than any acyclic wiring needs, so the bound only ever stops a cycle.
  for (let pass = 0; pending.length > 0 && pass <= edges.length; pass++) {
    for (const edge of pending) {
      readAt.set(edge, ++reads)
      const outcome = await resolveEdge(edge, nodesById, deps)
      if (outcome === 'skipped') {
        final.add(edge)
        continue
      }
      const target = nodesById.get(edge.target) as GraphNodeRecord
      if (isDeepStrictEqual(inputStateOf(target, edge.targetHandle), outcome)) {
        continue
      }
      nodesById.set(target.id, withInput(target, edge.targetHandle, outcome))
      inputsChangedAt.set(target.id, reads)
    }
    pending = edges.filter(
      (edge) => !final.has(edge) && (inputsChangedAt.get(edge.source) ?? 0) > (readAt.get(edge) ?? 0),
    )
  }

  return { ...graph, nodes: graph.nodes.map((node) => nodesById.get(node.id) ?? node) }
}

// A wired input handle is in exactly one of the two keys: its context under
// `__resolvedContexts`, or its id in `__unresolvedInputs` while its source
// exposes nothing, and then also in `__awaitingRun` when that nothing waits
// for a run. An empty key is left out.
function withInput(node: GraphNodeRecord, handleId: string, state: InputState): GraphNodeRecord {
  const {
    [CONTEXT_KEY]: storedContexts,
    [UNRESOLVED_KEY]: storedUnresolved,
    [AWAITING_KEY]: _awaiting,
    ...data
  } = node.data
  const { [handleId]: _, ...contexts } = (storedContexts as Record<string, ResolvedContextEntry> | undefined) ?? {}
  const unresolved = ((storedUnresolved as string[] | undefined) ?? []).filter((id) => id !== handleId)
  const awaiting = awaitingRunOf(node.data).filter((id) => id !== handleId)
  if (typeof state === 'object') {
    contexts[handleId] = state
  } else {
    unresolved.push(handleId)
    if (state === 'awaiting') {
      awaiting.push(handleId)
    }
  }
  return {
    ...node,
    data: {
      ...data,
      ...(Object.keys(contexts).length > 0 ? { [CONTEXT_KEY]: contexts } : {}),
      ...(unresolved.length > 0 ? { [UNRESOLVED_KEY]: unresolved } : {}),
      ...(awaiting.length > 0 ? { [AWAITING_KEY]: awaiting } : {}),
    },
  }
}

function inputStateOf(node: GraphNodeRecord, handleId: string): InputState {
  const contexts = node.data[CONTEXT_KEY] as Record<string, ResolvedContextEntry> | undefined
  if (contexts && Object.hasOwn(contexts, handleId)) {
    return contexts[handleId]
  }
  return awaitingRunOf(node.data).includes(handleId) ? 'awaiting' : 'unresolved'
}

// A Terminal Router's outputs re-expose terminals that are not wired to it —
// usually in another space — so the value each route carries is re-read from
// its target here, before any edge from the router is resolved. A target that
// no longer resolves loses its value rather than keeping the last one: the
// output then reads as disconnected instead of reaching a host that is gone.
async function refreshRoutes(
  data: Record<string, unknown>,
  deps: ContextResolverDeps,
): Promise<Record<string, unknown>> {
  const routes = data.routes as TerminalRoute[] | undefined
  if (!Array.isArray(routes) || routes.length === 0) {
    return data
  }
  const refreshed = await Promise.all(
    routes.map(async (route) => {
      const { context: _, ...rest } = route
      try {
        const context = await deps.resolveTerminalTarget(route.target)
        return context == null ? rest : { ...rest, context }
      } catch {
        return rest
      }
    }),
  )
  return { ...data, routes: refreshed }
}

// 'skipped' is final: the edge cannot resolve in any order (a missing source
// or handle, an extension without exposeOutput, or one that threw).
// 'unresolved' is a source that returns nothing as its data stands; it is read
// again once one of its own inputs changes. 'awaiting' is the same, for a
// source that has nothing because nothing runs: a run-time output outside its
// run, or a source one of whose own inputs awaits a run.
async function resolveEdge(
  edge: GraphEdgeRecord,
  nodesById: Map<string, GraphNodeRecord>,
  deps: ContextResolverDeps,
): Promise<InputState | 'skipped'> {
  const sourceNode = nodesById.get(edge.source)
  const sourceHandleId = edge.sourceHandle
  if (!sourceNode?.type || !sourceHandleId) {
    return 'skipped'
  }
  const extInfo = deps.nodeTypeToExtension.get(sourceNode.type)
  const bare = parseType(sourceNode.type)?.bare
  if (!extInfo || !bare) {
    return 'skipped'
  }
  // Read for its type and `runtime` only: a Switch's outputs, which follow an
  // enum's cases, carry no value.
  const sourceHandle = sourceHandleOf(
    sourceNode,
    sourceHandleId,
    (type) => deps.nodeTypeToExtension.get(type)?.handles ?? [],
    NO_ENUMS,
  )
  if (!sourceHandle) {
    return 'skipped'
  }
  try {
    const exposeOutput = await deps.exposeOutputOf(extInfo.extensionId)
    if (!exposeOutput) {
      return 'skipped'
    }
    const run = deps.runEventOf?.(sourceNode.id)
    const value = exposeOutput(sourceHandleId, sourceNode.data, bare, sourceNode.id, run, deps.enumCasesOf)
    if (value === undefined || value === null) {
      const awaitsRun =
        (sourceHandle.runtime === true && run === undefined) || awaitingRunOf(sourceNode.data).length > 0
      return awaitsRun ? 'awaiting' : 'unresolved'
    }
    return { sourceNodeId: sourceNode.id, sourceHandleId, handleType: sourceHandle.handleType, value }
  } catch (err) {
    console.error(`[graph-resolver] failed to resolve context for edge ${edge.source}->${edge.target}:`, err)
    return 'skipped'
  }
}
