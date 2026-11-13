// Which graphs read another graph's nodes. A Terminal Router carries, per
// route, the context of a terminal that may live in another graph (see
// terminal-router-shared), and that value is re-read only when the router's
// own graph is resolved. A change to the routed node therefore has to resolve
// the router's graph too; nothing else in the router's graph changes to do it.

import type { TerminalRoute } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/terminal-router-shared'
import { TERMINAL_ROUTER_NODE_TYPE } from '@/app/_authed/(extension-runtime)/_core-types'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

interface GraphEntry {
  id: string
  graph: GraphData
}

/**
 * The ids of the graphs, other than `graphId` itself, holding a Terminal
 * Router with a route to one of `nodeIds`. A route to an App's handle names
 * the App, not a node, and matches no node id.
 */
export function graphsRoutingTo(graphs: Iterable<GraphEntry>, graphId: string, nodeIds: ReadonlySet<string>): string[] {
  const dependents: string[] = []
  for (const entry of graphs) {
    if (entry.id !== graphId && entry.graph.nodes.some((node) => routesTo(node, nodeIds))) {
      dependents.push(entry.id)
    }
  }
  return dependents
}

function routesTo(node: Record<string, unknown>, nodeIds: ReadonlySet<string>): boolean {
  if (node.type !== TERMINAL_ROUTER_NODE_TYPE) {
    return false
  }
  const routes = (node.data as { routes?: TerminalRoute[] } | undefined)?.routes
  return (
    Array.isArray(routes) &&
    routes.some((route) => typeof route?.target === 'string' && nodeIds.has(route.target.split('/')[0]))
  )
}
