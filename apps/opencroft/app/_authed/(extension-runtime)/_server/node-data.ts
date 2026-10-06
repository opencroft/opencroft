// Generic helper for server-side node-data mutations: patches the node's
// data, persists the graph, and broadcasts a `node_data_updated` SSE event
// so connected clients can apply the change in-place without refetching.

import type { GraphWriteOrigin } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { toastStore } from '@/lib/toast-store'

const NODE_DATA_ORIGIN: GraphWriteOrigin = { kind: 'extension', name: 'node data' }
// A node's own data, written as the patcher left it.
const NODE_DATA_WRITE = { resolveContexts: false }

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
    if (!(graph.graph.nodes as unknown as MutableNode[]).some((n) => n.id === nodeId)) {
      continue
    }
    const data = await mutateLiveGraph(
      `${space.slug}.${graph.slug}`,
      NODE_DATA_ORIGIN,
      (current) => {
        const target = (current.nodes as unknown as MutableNode[]).find((n) => n.id === nodeId)
        if (target) {
          target.data = patcher(target.data ?? {})
        }
        return target?.data ?? null
      },
      NODE_DATA_WRITE,
    )
    if (data) {
      toastStore.broadcast({ type: 'node_data_updated', spaceId, nodeId, data })
    }
    return data
  }
  return null
}
