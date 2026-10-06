import { resolveGraphContexts } from '@/app/_authed/(extension-runtime)/_server/graph-context-resolver'
import type { GraphSnapshot } from '@/app/_authed/(extension-runtime)/_server/host'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

/** The graph with every edge's context resolved into its target node's data, as a graph is stored. */
export async function resolveGraph(graph: GraphData): Promise<GraphData> {
  const snapshot: GraphSnapshot = {
    nodes: graph.nodes as unknown as GraphSnapshot['nodes'],
    edges: graph.edges as unknown as GraphSnapshot['edges'],
  }
  const resolved = await resolveGraphContexts(snapshot)
  return {
    nodes: resolved.nodes as unknown as GraphData['nodes'],
    edges: resolved.edges as unknown as GraphData['edges'],
  }
}
