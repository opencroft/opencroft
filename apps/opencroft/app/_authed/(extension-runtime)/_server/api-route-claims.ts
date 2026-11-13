/**
 * The API Routes of the instance as the server serves them
 * (`api-route-table.ts`): the table a request is matched against, the path
 * errors each route holds, and the check that refuses a graph write giving
 * a route a path another route has, in any space.
 *
 * Routes' errors follow every change of any graph, a short while after the
 * change, and are brought in step at startup. Canvas edits reach the
 * server as collaborative changes it cannot refuse, so a path taken on the
 * canvas (typed, pasted, a graph copied in) is not refused but reported:
 * the route that was serving the path keeps it, and the new one shows why
 * it gets nothing.
 */

import type { NodeError } from '@opencroft/core'

import {
  describeRoute,
  normalizeRoutePath,
  PATH_ERROR_SOURCE,
  routePathKey,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/api-route-path'
import { API_ROUTE_NODE_TYPE } from '@/app/_authed/(extension-runtime)/_core-types'
import { withNodeErrors } from '@/app/_authed/(extension-runtime)/_node-errors'
import {
  type RouteNode,
  type RouteTable,
  routePathErrors,
  routeTable,
  type ServingMemory,
} from '@/app/_authed/(extension-runtime)/_server/api-route-table'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

// A burst of edits (typing a path) is reconciled once, this long after its first change.
const RECONCILE_DELAY_MS = 250

const shared = globalThis as unknown as {
  __apiRouteClaims?: {
    /** Which route served each path key. */
    memory: ServingMemory
    timer: ReturnType<typeof setTimeout> | undefined
    watching: boolean
  }
}
if (!shared.__apiRouteClaims) {
  shared.__apiRouteClaims = { memory: new Map(), timer: undefined, watching: false }
}
const state = shared.__apiRouteClaims

/** Replaces the path errors of a node (`graph.setNodeErrors`). */
export type ReportPathErrors = (nodeId: string, errors: NodeError[]) => Promise<void>

async function reportOnHost(nodeId: string, errors: NodeError[]): Promise<void> {
  // Imported on use: the host module loads the whole extension runtime.
  const { setNodeErrors } = await import('@/app/_authed/(extension-runtime)/_server/host')
  await setNodeErrors(nodeId, PATH_ERROR_SOURCE, errors)
}

interface StoredNode {
  id?: unknown
  type?: unknown
  data?: Record<string, unknown>
}

/** The API Route nodes of one graph. */
export function routeNodesOf(graph: GraphData, spaceSlug: string, graphAddress: string): RouteNode[] {
  return (graph.nodes as StoredNode[]).flatMap((node) => {
    if (node.type !== API_ROUTE_NODE_TYPE || typeof node.id !== 'string') {
      return []
    }
    const data = node.data ?? {}
    return [
      {
        nodeId: node.id,
        spaceSlug,
        graphAddress,
        path: normalizeRoutePath(data.path),
        key: routePathKey(data.path),
        data,
      },
    ]
  })
}

function allRoutes(exceptGraphId?: string): RouteNode[] {
  const registry = getSpacesRegistry()
  return registry
    .listGraphs()
    .filter((ref) => ref.graph.id !== exceptGraphId)
    .flatMap((ref) => routeNodesOf(ref.graph.graph, ref.space.slug, registry.addressOf(ref)))
}

/** The route table of the instance. The registry must be loaded. */
export function instanceRouteTable(): RouteTable {
  return routeTable(allRoutes(), state.memory)
}

/**
 * Brings the path errors of every route to what the table says. A route
 * whose errors are already those writes nothing; a failed write is logged and
 * the others still go ahead.
 */
export async function reconcileRoutePathErrors(report: ReportPathErrors = reportOnHost): Promise<void> {
  const table = instanceRouteTable()
  const errors = routePathErrors(table)
  for (const { routes } of table) {
    for (const route of routes) {
      const next = errors.get(route.nodeId) ?? []
      if (withNodeErrors(route.data, PATH_ERROR_SOURCE, next) === route.data) {
        continue
      }
      try {
        await report(route.nodeId, next)
      } catch (err) {
        console.error(`[api-route] route ${route.nodeId} could not record its path error:`, err)
      }
    }
  }
}

function reconcileLater(): void {
  // A pending check is left to run: it comes RECONCILE_DELAY_MS after the
  // first change of a burst, so graphs that keep changing cannot put it off.
  if (state.timer !== undefined) {
    return
  }
  state.timer = setTimeout(() => {
    state.timer = undefined
    reconcileRoutePathErrors().catch((err) => console.error('[api-route] could not check the route paths:', err))
  }, RECONCILE_DELAY_MS)
}

/** Keeps every route's path errors in step with the graphs, from now on and for what is stored. */
export async function watchRoutePaths(): Promise<void> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  // Remembers at once which route serves each path, so a route that takes a
  // served path before the first check or request finds that path held.
  instanceRouteTable()
  if (!state.watching) {
    state.watching = true
    registry.onGraphChanged(reconcileLater)
    // A removed graph takes its routes, which may leave another route alone on its path.
    registry.onGraphsRemoved(reconcileLater)
  }
  reconcileLater()
}

/** Each API Route of a graph by node id, with its path key: what `routePathRefusal` compares with. */
export function routePathKeys(graph: GraphData): Map<string, string> {
  return new Map(routeNodesOf(graph, '', '').map((route) => [route.nodeId, route.key]))
}

/**
 * Why a write that turned the graph at `address` into `after` is refused, or
 * undefined when it gives no route a path another route has. `beforeKeys` is
 * `routePathKeys` of the graph before the write. Only the routes the write
 * created or gave a new path are checked, so a write that leaves an existing
 * clash as it is goes ahead. A route in another space is not named.
 */
export function routePathRefusal(
  address: string,
  beforeKeys: ReadonlyMap<string, string>,
  after: GraphData,
): string | undefined {
  const registry = getSpacesRegistry()
  const ref = registry.resolveGraph(address)
  if (!ref) {
    return undefined
  }
  const spaceSlug = ref.space.slug
  const here = routeNodesOf(after, spaceSlug, registry.addressOf(ref))
  const everywhere = [...here, ...allRoutes(ref.graph.id)]
  for (const route of here) {
    if (beforeKeys.get(route.nodeId) === route.key) {
      continue
    }
    const others = everywhere.filter((other) => other.key === route.key && other.nodeId !== route.nodeId)
    if (others.length > 0) {
      const named = [...new Set(others.map((other) => describeRoute(other, spaceSlug)))].join(', ')
      return `Route Path ${route.path} of ${route.nodeId} is taken: it is the path of ${named}. A path belongs to one route on this instance; give this route another path, or change or delete that route first.`
    }
  }
  return undefined
}
