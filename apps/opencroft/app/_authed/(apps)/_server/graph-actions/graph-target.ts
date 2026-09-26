/**
 * What every graph action shares: the graph an action runs on, the node and
 * edge shapes a graph stores, and the argument checks the actions all make.
 */

import type { ParsedEndpoint } from '@/app/_authed/(mcp)/_server/endpoint'
import { fail } from '@/app/_authed/(mcp)/_server/tool-refusal'
import type { GraphNode } from '@/app/_authed/(mcp)/_server/tool-shared'
import { loadSpaceGraphImpl, registry } from '@/app/_authed/(space)/_server/actions-impl'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

export type { GraphNode }

export interface StoredEdge extends Record<string, unknown> {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

export interface GraphTarget {
  /** `<space>.<graph>` — what the graph is loaded and saved by. */
  address: string
  /**
   * The graph's space, canonical. Overlay events and approvals are scoped by
   * it: every canvas of a space subscribes under the bare space slug — the
   * first segment of `/space/<space>/…` — whichever of its graphs it shows.
   */
  spaceSlug: string
}

/**
 * The graph an action runs on — the one the called app instance owns. Resolved
 * from the instance rather than from any argument, which is what makes the
 * address required by construction: an action cannot be reached without one,
 * and cannot name a different graph than the one it was called on.
 */
export async function graphTarget(ctx: { instanceId: string }): Promise<GraphTarget> {
  const r = await registry()
  const graph = r.graphByInstance(ctx.instanceId)
  const space = graph ? r.getById(graph.spaceId) : null
  if (!graph || !space) {
    fail(-32602, 'This graph app has no graph.')
  }
  return { address: `${space.slug}.${graph.slug}`, spaceSlug: space.slug }
}

export async function loadOrFail(address: string): Promise<{ graph: GraphData; updatedAt: string }> {
  const result = await loadSpaceGraphImpl(address)
  if (!result) {
    fail(-32602, `Graph not found: ${address}`)
  }
  return result
}

export function requireArray<T = unknown>(value: unknown, name: string): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(-32602, `Missing required param: ${name} (non-empty array)`)
  }
  return value as T[]
}

export function edgeMatches(edge: StoredEdge, endpoint: { source: ParsedEndpoint; target: ParsedEndpoint }): boolean {
  if (edge.source !== endpoint.source.nodeId || edge.target !== endpoint.target.nodeId) {
    return false
  }
  if (endpoint.source.handle !== undefined && edge.sourceHandle !== endpoint.source.handle) {
    return false
  }
  if (endpoint.target.handle !== undefined && edge.targetHandle !== endpoint.target.handle) {
    return false
  }
  return true
}

export function formatEndpoint(nodeId: string, handle?: string): string {
  return handle ? `${nodeId}/${handle}` : nodeId
}

export function edgeToApi(edge: StoredEdge): Record<string, unknown> {
  return {
    id: edge.id,
    source: formatEndpoint(edge.source, edge.sourceHandle),
    target: formatEndpoint(edge.target, edge.targetHandle),
  }
}

export const EDGE_ENDPOINT_DESCRIPTION = 'Node ID, optionally with handle after a slash (e.g. "node-id/out").'
