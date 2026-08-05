import { resolveGraphContexts } from '@/app/_authed/(extension-runtime)/_server/graph-context-resolver'
import type { GraphSnapshot } from '@/app/_authed/(extension-runtime)/_server/host'
import { getExtensionModule, loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import { getStream } from '@/app/_authed/(extension-runtime)/_server/stream'
import type {
  ConnectedSource,
  NodeActionCtx,
  NodeActionCtxNode,
  NodeActionDescriptor,
  ResolvedInput,
  Stream,
} from '@/app/_authed/(extension-runtime)/_types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

const ERRORS_KEY = '__errors'

export interface GraphNodeLike {
  id: string
  type?: string
  position?: { x: number; y: number }
  data?: Record<string, unknown>
  style?: Record<string, unknown>
}

interface GraphEdgeLike {
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

interface ResolvedHandle {
  sourceNodeId?: string
  sourceHandleId?: string
  contextType?: string
  value?: unknown
}

export interface FoundNode {
  slug: string
  graph: GraphData
  node: GraphNodeLike
}

// Kept in this module, separate from node-actions.ts's createServerFn exports, and
// never imported by client-side code (see exec-dispatch.ts). TanStack's server-fn
// client-build code splitting only elides a *handler body*, not a shared file's own
// top-level imports — a plain export living alongside createServerFn exports keeps
// their imports "live" for the client bundle too. That let loader.ts's eager
// compiler.ts import (tailwindcss/lightningcss native bindings) leak into the client
// dependency graph and broke the production build.
export async function findNodeWithGraph(nodeId: string): Promise<FoundNode | null> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  for (const summary of r.list()) {
    const space = r.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    const hasNode = space.graph.nodes.some((n) => (n as unknown as GraphNodeLike).id === nodeId)
    if (!hasNode) {
      continue
    }
    const snapshot: GraphSnapshot = {
      nodes: space.graph.nodes as unknown as GraphSnapshot['nodes'],
      edges: space.graph.edges as unknown as GraphSnapshot['edges'],
    }
    const resolved = await resolveGraphContexts(snapshot)
    const graph = {
      nodes: resolved.nodes as unknown as GraphData['nodes'],
      edges: resolved.edges as unknown as GraphData['edges'],
    }
    const node = graph.nodes.find((n) => (n as unknown as GraphNodeLike).id === nodeId) as unknown as GraphNodeLike
    return { slug: summary.slug, graph, node }
  }
  return null
}

function nodesAsLike(graph: GraphData): GraphNodeLike[] {
  return graph.nodes as unknown as GraphNodeLike[]
}

function edgesAsLike(graph: GraphData): GraphEdgeLike[] {
  return graph.edges as unknown as GraphEdgeLike[]
}

function buildCtx(
  graph: GraphData,
  node: GraphNodeLike,
  params: Record<string, unknown>,
  spaceId: string,
  pending: Record<string, unknown>,
): NodeActionCtx {
  const data = node.data ?? {}
  const resolved = (data['__resolvedContexts'] as Record<string, ResolvedHandle> | undefined) ?? {}
  const allNodes = nodesAsLike(graph)
  const allEdges = edgesAsLike(graph)

  const input = <T>(handleId: string): T | undefined => {
    return resolved[handleId]?.value as T | undefined
  }

  const inputSource = <T>(handleId: string): ResolvedInput<T> | undefined => {
    const entry = resolved[handleId]
    if (!entry || entry.sourceNodeId === undefined) {
      return undefined
    }
    return {
      sourceNodeId: entry.sourceNodeId,
      sourceHandleId: entry.sourceHandleId ?? '',
      contextType: entry.contextType ?? '',
      value: entry.value as T,
    }
  }

  const connectedSources = (handleId: string): ConnectedSource[] => {
    const matches: ConnectedSource[] = []
    for (const edge of allEdges) {
      if (edge.target !== node.id || edge.targetHandle !== handleId) {
        continue
      }
      const source = allNodes.find((n) => n.id === edge.source)
      if (!source) {
        continue
      }
      matches.push({
        nodeId: source.id,
        handleId: edge.sourceHandle ?? '',
        type: source.type,
        data: source.data ?? {},
      })
    }
    return matches
  }

  const containingNodes = (typeId?: string): NodeActionCtxNode[] => {
    const sx = node.position?.x ?? 0
    const sy = node.position?.y ?? 0
    return allNodes
      .filter((n) => {
        if (n.id === node.id) {
          return false
        }
        if (typeId && n.type !== typeId) {
          return false
        }
        const px = n.position?.x ?? 0
        const py = n.position?.y ?? 0
        const w = (n.style?.['width'] as number | undefined) ?? 200
        const h = (n.style?.['height'] as number | undefined) ?? 160
        return sx >= px && sy >= py && sx < px + w && sy < py + h
      })
      .map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position ?? { x: 0, y: 0 },
        data: n.data ?? {},
      }))
  }

  const output = <T>(handleId: string): Stream<T> => {
    return getStream<T>(spaceId, node.id, handleId)
  }

  const updateData = (patch: Record<string, unknown>): void => {
    Object.assign(data, patch)
    Object.assign(pending, patch)
  }

  return {
    nodeId: node.id,
    typeId: node.type ?? '',
    data,
    params,
    input,
    inputSource,
    connectedSources,
    containingNodes,
    output,
    updateData,
  }
}

async function persistErrors(found: FoundNode, errors: string[]): Promise<void> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  const space = r.getBySlug(found.slug)
  if (!space) {
    return
  }
  const node = space.graph.nodes.find((n) => (n as unknown as GraphNodeLike).id === found.node.id) as unknown as
    | GraphNodeLike
    | undefined
  if (!node) {
    return
  }
  const data = (node.data ??= {})
  if (errors.length > 0) {
    data[ERRORS_KEY] = errors
  } else {
    delete data[ERRORS_KEY]
  }
  await r.saveGraph(found.slug, space.graph)
}

// Persist a data patch produced by a node action (via ctx.updateData) back to
// the stored graph, so actions can configure their own node (e.g. assign a key).
async function persistData(found: FoundNode, patch: Record<string, unknown>): Promise<void> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  const space = r.getBySlug(found.slug)
  if (!space) {
    return
  }
  const node = space.graph.nodes.find((n) => (n as unknown as GraphNodeLike).id === found.node.id) as unknown as
    | GraphNodeLike
    | undefined
  if (!node) {
    return
  }
  node.data = { ...(node.data ?? {}), ...patch }
  await r.saveGraph(found.slug, space.graph)
}

// Plain (non-server-fn) implementation — see extension-action-impl.ts's
// invokeExtensionActionImpl for why this exists alongside the createServerFn-wrapped
// version in node-actions.ts: a caller with no Start request context (an MCP call,
// the scheduler) gets nothing back from the server-fn wrapper — the handler runs but
// its return value is dropped — while this plain function returns it normally.
export async function listNodeActionsImpl(nodeId: string): Promise<NodeActionDescriptor[]> {
  const found = await findNodeWithGraph(nodeId)
  if (!found || !found.node.type) {
    return []
  }
  const manifests = await loadAllManifests()
  for (const manifest of manifests) {
    const meta = manifest.nodes?.find((n) => n.typeId === found.node.type)
    if (!meta?.actions) {
      continue
    }
    return meta.actions.map((a) => ({
      nodeId,
      typeId: found.node.type ?? '',
      extensionId: manifest.id,
      actionId: a.id,
      label: a.label,
      description: a.description,
      inputSchema: a.inputSchema,
    }))
  }
  return []
}

// Plain (non-server-fn) implementation — see extension-action-impl.ts's
// invokeExtensionActionImpl for why this exists alongside the createServerFn-wrapped
// version below: calling a createServerFn from inside another createServerFn's handler
// is fragile, and a caller with no request context at all (a background scheduler tick)
// can't use the wrapper regardless. exec-dispatch.ts uses this directly for that reason.
export async function dispatchNodeActionImpl(data: {
  nodeId: string
  actionId: string
  params?: Record<string, unknown>
}): Promise<unknown> {
  const { nodeId, actionId } = data
  const params = data.params ?? {}
  const found = await findNodeWithGraph(nodeId)
  if (!found) {
    throw new Error(`Node not found: ${nodeId}`)
  }
  const typeId = found.node.type
  if (!typeId) {
    throw new Error(`Node ${nodeId} has no typeId`)
  }
  const manifests = await loadAllManifests()
  const owning = manifests.find((m) => m.nodes?.some((n) => n.typeId === typeId))
  if (!owning) {
    throw new Error(`No extension declares node typeId "${typeId}"`)
  }
  const mod = await getExtensionModule(owning.id)
  const handler = mod.nodeActions?.[typeId]?.[actionId]
  if (!handler) {
    throw new Error(`Extension ${owning.id} has no nodeAction "${typeId}.${actionId}"`)
  }
  const pending: Record<string, unknown> = {}
  const ctx = buildCtx(found.graph, found.node, params, found.slug, pending)
  await persistErrors(found, [])
  try {
    const result = await handler(ctx)
    if (Object.keys(pending).length > 0) {
      await persistData(found, pending)
    }
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The node's own __errors only ever gets the bare message (surfaced in the
    // UI/MCP response) — without this, the *only* diagnostic signal for a node
    // action failure was that string, no stack, nowhere to find the actual
    // throw site.
    console.error(`[node-action] ${typeId}.${actionId} (node ${nodeId}) failed:`, err)
    await persistErrors(found, [message])
    throw err
  }
}
