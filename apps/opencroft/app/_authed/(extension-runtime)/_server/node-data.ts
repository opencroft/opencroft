// Generic helper for server-side node-data mutations: patches the node's
// data, persists the graph, and broadcasts a `node_data_updated` SSE event
// so connected clients can apply the change in-place without refetching.

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
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
  // Whichever of the space's graphs holds the node -- the caller scopes by
  // space, and which canvas the node was drawn on is not its concern.
  for (const graph of space.graphs.values()) {
    const node = (graph.graph.nodes as unknown as MutableNode[]).find((n) => n.id === nodeId)
    if (!node) {
      continue
    }
    const prev = node.data ?? {}
    const next = patcher(prev)
    node.data = next
    await r.saveGraph(`${space.slug}.${graph.slug}`, graph.graph)
    toastStore.broadcast({ type: 'node_data_updated', spaceId, nodeId, data: next })
    return next
  }
  return null
}
