// Generic helper for server-side node-data mutations: patches the node's
// data, persists the graph, and broadcasts a `node_data_updated` SSE event
// so connected clients can apply the change in-place without refetching.

import { getSpacesRegistry } from '@/app/(space)/_server/store'
import { toastStore } from '@/lib/toast-store'

export type DataPatcher = (prev: Record<string, unknown>) => Record<string, unknown>

interface MutableNode {
  id: string
  data?: Record<string, unknown>
}

export async function updateNodeData(
  spaceId: string,
  nodeId: string,
  patcher: DataPatcher,
): Promise<Record<string, unknown> | null> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  const space = r.getBySlug(spaceId)
  if (!space) {
    return null
  }
  const node = (space.graph.nodes as unknown as MutableNode[]).find((n) => n.id === nodeId)
  if (!node) {
    return null
  }
  const prev = node.data ?? {}
  const next = patcher(prev)
  node.data = next
  await r.saveGraph(spaceId, space.graph)
  toastStore.broadcast({ type: 'node_data_updated', spaceId, nodeId, data: next })
  return next
}
