import type { NodeError } from '@opencroft/core'
import type { NodeCheckEdge, NodeCheckInstance } from '@opencroft/server/graph'

import {
  routesToRoutes,
  routeToRouteText,
  TERMINAL_ROUTER_TYPE,
  type TerminalRouterData,
  targetNodeId,
} from '../src/nodes/terminal-router-shared'

/**
 * The Terminal Router's check (`nodeChecks`). A graph write that adds a route
 * to another router's route is refused (`router-route-refusal.ts`), and the
 * inspector's picker does not offer one; a route that reaches the graph some
 * other way (a canvas paste or edit, which the server cannot refuse) is
 * reported here, one finding per route.
 */
export function terminalRouterCheck(
  node: { id: string; data: TerminalRouterData },
  _edges: readonly NodeCheckEdge[],
  instance: NodeCheckInstance,
): NodeError[] {
  const routers = new Set(instance.nodesOfType(TERMINAL_ROUTER_TYPE).map((router) => router.id))
  return routesToRoutes(node.data, (id) => routers.has(id)).map((route) => ({
    title: 'Route to another route',
    detail: routeToRouteText(route.target, targetNodeId(route.target)),
    next: 'Remove this route and add the terminal that route reaches.',
  }))
}
