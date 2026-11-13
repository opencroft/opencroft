// The refusal of a graph write that gives a Terminal Router a route to another
// router's route, on any graph. Canvas edits reach the server as
// collaborative changes it cannot refuse; such a route is reported on the
// router by its check (`terminal-router-check.ts`) instead.

import {
  routesToRoutes,
  routeTarget,
  routeToRouteText,
  type TerminalRouterData,
  targetNodeId,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/terminal-router-shared'
import { TERMINAL_ROUTER_NODE_TYPE } from '@/app/_authed/(extension-runtime)/_core-types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

interface StoredNode {
  id: string
  type?: unknown
  data?: Record<string, unknown>
}

function routersOf(graph: GraphData): StoredNode[] {
  return (graph.nodes as unknown as StoredNode[]).filter((node) => node.type === TERMINAL_ROUTER_NODE_TYPE)
}

/** Each Terminal Router of `graph` with the targets of its routes, by node id. */
export function routeTargetsOf(graph: GraphData): Map<string, Set<string>> {
  return new Map(
    routersOf(graph).map((node) => [
      node.id,
      new Set(((node.data as TerminalRouterData | undefined)?.routes ?? []).map((route) => route?.target)),
    ]),
  )
}

/**
 * Why a write that turned a graph into `after` is refused, or undefined when
 * it gives no router a route to a router's route. `before` is
 * `routeTargetsOf` of the graph before the write. Only the routes the write
 * added are checked, so a write that leaves an existing one as it is goes
 * ahead. A node of `after` is read as the write left it; any other, from the
 * graph it is stored on.
 */
export function routerRouteRefusal(
  before: ReadonlyMap<string, ReadonlySet<string>>,
  after: GraphData,
): string | undefined {
  const registry = getSpacesRegistry()
  const here = new Map((after.nodes as unknown as StoredNode[]).map((node) => [node.id, node]))
  const nodeOf = (id: string): StoredNode | undefined =>
    here.get(id) ??
    (registry.findByNode(id)?.graph.graph.nodes as unknown as StoredNode[] | undefined)?.find((node) => node.id === id)
  for (const router of routersOf(after)) {
    const had = before.get(router.id)
    const added = routesToRoutes(
      (router.data ?? {}) as TerminalRouterData,
      (id) => nodeOf(id)?.type === TERMINAL_ROUTER_NODE_TYPE,
    ).filter((route) => !had?.has(route.target))
    const [route] = added
    if (route) {
      const routerId = targetNodeId(route.target)
      const reaches = routeTarget(
        route.target.slice(routerId.length + 1),
        (nodeOf(routerId)?.data ?? {}) as TerminalRouterData,
      )
      return `Route ${route.id} of ${router.id}: ${routeToRouteText(route.target, routerId, reaches)}`
    }
  }
  return undefined
}
