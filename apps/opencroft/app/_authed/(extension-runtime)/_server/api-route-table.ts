/**
 * Which API Route of the instance serves each path, and what each route
 * reports about a path it shares (`api-route-path.ts` has the path rules).
 *
 * A path belongs to one route. When more than one route has it:
 * - The route that was serving it keeps it, and the others get no requests.
 *   Which one that was is remembered in memory while the server runs, and
 *   read back from the routes' stored errors after a restart: a route that
 *   gets no requests holds a `taken` error, the one that serves holds `held`.
 * - When none of them is known to have served it first (they arrived
 *   together, or none holds an error recording that it served), none
 *   serves it, and every request to it gets 409.
 * Either way every route involved holds an error naming the others.
 *
 * Host-free: the registry is read in `api-route-claims.ts`.
 */

import type { NodeError } from '@opencroft/core'

import {
  compareRoutePathKeys,
  matchRoutePath,
  PATH_ERROR_CODE,
  PATH_ERROR_SOURCE,
  pathHeldError,
  pathSharedError,
  pathTakenError,
  type RouteRef,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/api-route-path'
import { readNodeErrors } from '@/app/_authed/(extension-runtime)/_node-errors'

/** An API Route node, with its path read. */
export interface RouteNode extends RouteRef {
  /** Normalized (`normalizeRoutePath`). */
  path: string
  /** `routePathKey` of the path. */
  key: string
  data: Record<string, unknown>
}

/** The routes of one path key, and which of them serves it. */
export interface RouteClaim {
  key: string
  routes: RouteNode[]
  /** Undefined when the routes share the path and none serves it. */
  holder: RouteNode | undefined
}

/** The routes by path key, most specific path first. */
export type RouteTable = RouteClaim[]

/** Per path key, the node id of the route that served it when last seen. */
export type ServingMemory = Map<string, string>

export type RouteMatch =
  | { kind: 'route'; route: RouteNode; params: Record<string, string> }
  | { kind: 'shared'; claim: RouteClaim }
  | { kind: 'none' }

function pathErrorCode(route: RouteNode): string | undefined {
  return readNodeErrors(route.data).find((entry) => entry.source === PATH_ERROR_SOURCE)?.code
}

function holderOf(routes: RouteNode[], served: string | undefined): RouteNode | undefined {
  if (routes.length === 1) {
    return routes[0]
  }
  const remembered = routes.find((route) => route.nodeId === served)
  if (remembered) {
    return remembered
  }
  // Nothing remembered (after a restart): the stored errors tell. A route
  // recorded as getting nothing, or as sharing a path nobody served, is not
  // a candidate. A pasted copy of a route carries its data, errors included,
  // which is why the memory above is asked first.
  const candidates = routes.filter((route) => {
    const code = pathErrorCode(route)
    return code === undefined || code === PATH_ERROR_CODE.held
  })
  return candidates.length === 1 ? candidates[0] : undefined
}

/**
 * The table of `routes`, deciding each shared path's holder from `memory`
 * and the routes' stored errors. Updates `memory` to the holders decided.
 */
export function routeTable(routes: readonly RouteNode[], memory: ServingMemory): RouteTable {
  const byKey = new Map<string, RouteNode[]>()
  for (const route of routes) {
    byKey.set(route.key, [...(byKey.get(route.key) ?? []), route])
  }
  for (const key of memory.keys()) {
    if (!byKey.has(key)) {
      memory.delete(key)
    }
  }
  const table: RouteTable = []
  for (const [key, sharing] of byKey) {
    const holder = holderOf(sharing, memory.get(key))
    if (holder) {
      memory.set(key, holder.nodeId)
    } else {
      memory.delete(key)
    }
    table.push({ key, routes: sharing, holder })
  }
  return table.sort((a, b) => compareRoutePathKeys(a.key, b.key))
}

/** Which route a request path reaches: the most specific path that matches it. */
export function matchRoute(table: RouteTable, requestPath: string): RouteMatch {
  for (const claim of table) {
    const params = matchRoutePath(claim.key, requestPath)
    if (!params) {
      continue
    }
    if (!claim.holder) {
      return { kind: 'shared', claim }
    }
    // The key names every parameter `:`; the holder's own path names them.
    return { kind: 'route', route: claim.holder, params: matchRoutePath(claim.holder.path, requestPath) ?? {} }
  }
  return { kind: 'none' }
}

/** The path errors each route of the table should hold: none for a path it alone has. */
export function routePathErrors(table: RouteTable): Map<string, NodeError[]> {
  const errors = new Map<string, NodeError[]>()
  for (const { routes, holder } of table) {
    for (const route of routes) {
      const others = routes.filter((other) => other !== route)
      if (others.length === 0) {
        errors.set(route.nodeId, [])
      } else if (!holder) {
        errors.set(route.nodeId, [pathSharedError(route, route.path, others)])
      } else if (route === holder) {
        errors.set(route.nodeId, [pathHeldError(route, route.path, others)])
      } else {
        errors.set(route.nodeId, [pathTakenError(route, route.path, holder)])
      }
    }
  }
  return errors
}
