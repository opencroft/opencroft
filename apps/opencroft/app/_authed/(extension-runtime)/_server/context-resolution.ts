// The resolution itself, kept free of the extension runtime so its ORDER can
// be tested with a fake exposeOutput. Loading the runtime opens the database.
import {
  TERMINAL_ROUTER_TYPE,
  type TerminalRoute,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/terminal-router-shared'
import type { GraphEdgeRecord, GraphNodeRecord, GraphSnapshot } from '@/app/_authed/(extension-runtime)/_server/host'
import type { NodeTypeHandles } from '@/app/_authed/(extension-runtime)/_server/node-handles'
import { findExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

interface ResolvedContextEntry {
  sourceNodeId: string
  sourceHandleId: string
  contextType: string
  value: unknown
}

const CONTEXT_KEY = '__resolvedContexts'

export type ExposeOutput = (
  handleId: string,
  nodeData: Record<string, unknown>,
  typeId: string,
  nodeId: string,
) => unknown

export interface ContextResolverDeps {
  nodeTypeToExtension: Map<string, NodeTypeHandles>
  exposeOutputOf(extensionId: string): Promise<ExposeOutput | undefined>
  /** A "node-id/handle-id" terminal source's context, as terminal.getContext resolves it; throws when it does not resolve. */
  resolveTerminalTarget(target: string): Promise<unknown>
}

/**
 * Calls exposeOutput on every edge's source node and writes the resolved
 * context into the target node's data, replacing whatever was stored there.
 *
 * A source's output can depend on one of that same node's inputs: an
 * application node builds its per-container terminal context from its own
 * resolved docker input, so the edge feeding a script from that container
 * resolves only once the docker edge has. Edges are stored in creation order,
 * which need not be dependency order, so one pass over them resolves such an
 * edge only by luck. Passes repeat over the edges still unresolved until a pass
 * resolves nothing new; each pass reads the data the previous one wrote.
 */
export async function resolveContexts(graph: GraphSnapshot, deps: ContextResolverDeps): Promise<GraphSnapshot> {
  const nodesById = new Map<string, GraphNodeRecord>()
  for (const node of graph.nodes) {
    const { [CONTEXT_KEY]: _, ...data } = node.data
    nodesById.set(node.id, { ...node, data })
  }
  for (const node of nodesById.values()) {
    if (node.type === TERMINAL_ROUTER_TYPE) {
      nodesById.set(node.id, { ...node, data: await refreshRoutes(node.data, deps) })
    }
  }

  let pending = graph.edges
  let progressed = true
  while (progressed && pending.length > 0) {
    progressed = false
    const unresolved: GraphEdgeRecord[] = []
    for (const edge of pending) {
      const target = nodesById.get(edge.target)
      const targetHandle = edge.targetHandle
      if (!target || !targetHandle) {
        continue
      }
      const outcome = await resolveEdge(edge, nodesById, deps)
      if (outcome === 'skipped') {
        continue
      }
      if (outcome === 'unresolved') {
        unresolved.push(edge)
        continue
      }
      const contexts = (target.data[CONTEXT_KEY] as Record<string, ResolvedContextEntry> | undefined) ?? {}
      nodesById.set(target.id, {
        ...target,
        data: { ...target.data, [CONTEXT_KEY]: { ...contexts, [targetHandle]: outcome } },
      })
      progressed = true
    }
    pending = unresolved
  }

  return { ...graph, nodes: graph.nodes.map((node) => nodesById.get(node.id) ?? node) }
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
// 'unresolved' is a source that returned nothing THIS pass and may resolve once
// its own inputs are written, so the edge is retried.
async function resolveEdge(
  edge: GraphEdgeRecord,
  nodesById: Map<string, GraphNodeRecord>,
  deps: ContextResolverDeps,
): Promise<ResolvedContextEntry | 'unresolved' | 'skipped'> {
  const sourceNode = nodesById.get(edge.source)
  const sourceHandleId = edge.sourceHandle
  if (!sourceNode?.type || !sourceHandleId) {
    return 'skipped'
  }
  const extInfo = deps.nodeTypeToExtension.get(sourceNode.type)
  if (!extInfo) {
    return 'skipped'
  }
  const sourceHandle = findExtensionHandle(extInfo.handles, sourceHandleId, 'source')
  if (!sourceHandle) {
    return 'skipped'
  }
  try {
    const exposeOutput = await deps.exposeOutputOf(extInfo.extensionId)
    if (!exposeOutput) {
      return 'skipped'
    }
    const value = exposeOutput(sourceHandleId, sourceNode.data, sourceNode.type, sourceNode.id)
    if (value === undefined || value === null) {
      return 'unresolved'
    }
    return { sourceNodeId: sourceNode.id, sourceHandleId, contextType: sourceHandle.contextType, value }
  } catch (err) {
    console.error(`[graph-resolver] failed to resolve context for edge ${edge.source}->${edge.target}:`, err)
    return 'skipped'
  }
}
