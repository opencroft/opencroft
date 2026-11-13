import { resolveGraphContexts } from '@/app/_authed/(extension-runtime)/_server/graph-context-resolver'
import type { GraphSnapshot } from '@/app/_authed/(extension-runtime)/_server/host'
import { withCheckedErrors } from '@/app/_authed/(extension-runtime)/_server/node-data-validation'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

/**
 * The graph as it is stored: every edge's context resolved into its target
 * node's data, every node's data problems (its type's data validator) stored
 * as its `data` errors, and what its type's check finds in its data and
 * wiring as its `check` errors. `checked` names the instance's graph it is
 * (see `withCheckedErrors`).
 */
export async function resolveGraph(graph: GraphData, checked?: { id: string; address: string }): Promise<GraphData> {
  const snapshot: GraphSnapshot = {
    nodes: graph.nodes as unknown as GraphSnapshot['nodes'],
    edges: graph.edges as unknown as GraphSnapshot['edges'],
  }
  const resolved = await resolveGraphContexts(snapshot)
  return withCheckedErrors(
    {
      nodes: resolved.nodes as unknown as GraphData['nodes'],
      edges: resolved.edges as unknown as GraphData['edges'],
    },
    checked,
  )
}
