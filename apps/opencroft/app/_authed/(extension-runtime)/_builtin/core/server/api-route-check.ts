import type { NodeError } from '@opencroft/core'
import type { NodeCheckEdge } from '@opencroft/server/graph'

/**
 * The API Route's check (`nodeChecks`). A route with no edge on its exec-out
 * handle answers every request with 502 ("API Route has no connected
 * handler"), so the node says so before a request finds out. A header no
 * request can carry is the route's data problem (`apiRouteDataProblems`). A
 * protecting secret that cannot be resolved is reported when a request meets
 * it (`api-route-access.ts`).
 */
export function apiRouteCheck(node: { id: string }, edges: readonly NodeCheckEdge[]): NodeError[] {
  if (edges.some((e) => e.source === node.id && e.sourceHandle === 'exec-out')) {
    return []
  }
  return [
    {
      title: 'No connected handler',
      detail: 'This route answers every request with 502 until something handles it.',
      next: 'Connect the Handler output to the node that should answer the request.',
    },
  ]
}
