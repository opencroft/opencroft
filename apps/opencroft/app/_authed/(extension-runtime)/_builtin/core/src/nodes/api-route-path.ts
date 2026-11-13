// ═══════════════════════════════════════════════════════════════════
// Where an API Route answers, and which route a path belongs to
//
// A route answers at `/api/route<path>`, and a path belongs to one route on
// the whole instance, whichever space it is in. Two paths are the same path
// when they match the same requests: segment for segment, a `:param`
// matching anything, whatever the parameter is called (`/users/:id` and
// `/users/:name` are one path). Distinct paths can both match a request
// (`/users/me` and `/users/:id`); the request then goes to the path whose
// first differing segment is literal.
//
// A clash names the other route only to someone who can see it: an error is
// read by whoever can open the route's own space, so a route in another
// space is "a route in another space", without its id or where it is.
//
// Host-free, so the inspector and the server read the same rules.
// ═══════════════════════════════════════════════════════════════════

import type { NodeError } from '@opencroft/core'

/** The URL prefix every API Route answers under. */
export const API_ROUTE_URL_PREFIX = '/api/route'

/** The node error source a route's path clash is reported under. */
export const PATH_ERROR_SOURCE = 'path'

/** The `code` of each path clash error: what the route does about it. */
export const PATH_ERROR_CODE = {
  /** This route serves the path; another route also has it and gets nothing. */
  held: 'route-path-held',
  /** Another route serves the path; this one gets nothing. */
  taken: 'route-path-taken',
  /** Several routes have the path and none serves it: every request gets 409. */
  shared: 'route-path-shared',
} as const

/** A route as a clash names it. */
export interface RouteRef {
  nodeId: string
  spaceSlug: string
  /** The graph it is on, `<space>.<graph>`. */
  graphAddress: string
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '')
}

function isParam(segment: string): boolean {
  return segment.startsWith(':')
}

/** A route's path as it is shown and served: one leading slash, no empty segments. */
export function normalizeRoutePath(path: unknown): string {
  return `/${segmentsOf(typeof path === 'string' ? path : '').join('/')}`
}

/** What two paths share when they are the same path: their segments, every `:param` as `:`. */
export function routePathKey(path: unknown): string {
  const segments = segmentsOf(normalizeRoutePath(path))
  return `/${segments.map((segment) => (isParam(segment) ? ':' : segment)).join('/')}`
}

/** The URL path a route answers at. */
export function routeUrlPath(path: unknown): string {
  const normalized = normalizeRoutePath(path)
  return normalized === '/' ? API_ROUTE_URL_PREFIX : `${API_ROUTE_URL_PREFIX}${normalized}`
}

/** The parameters a request path gives a route path, or undefined when it does not match. */
export function matchRoutePath(path: string, requestPath: string): Record<string, string> | undefined {
  const pattern = segmentsOf(path)
  const actual = segmentsOf(requestPath)
  if (pattern.length !== actual.length) {
    return undefined
  }
  const params: Record<string, string> = {}
  for (const [i, segment] of pattern.entries()) {
    if (isParam(segment)) {
      params[segment.slice(1)] = actual[i]
    } else if (segment !== actual[i]) {
      return undefined
    }
  }
  return params
}

/**
 * Orders path keys most specific first: at the first segment where two keys
 * differ, a literal comes before `:`. Keys of different lengths never match
 * the same request, so their order is only made stable.
 */
export function compareRoutePathKeys(a: string, b: string): number {
  const sa = segmentsOf(a)
  const sb = segmentsOf(b)
  if (sa.length !== sb.length) {
    return sa.length - sb.length
  }
  for (const [i, segment] of sa.entries()) {
    const other = sb[i]
    if (segment === other) {
      continue
    }
    if (segment === ':' || other === ':') {
      return segment === ':' ? 1 : -1
    }
    return segment < other ? -1 : 1
  }
  return 0
}

/** `route` as told to someone working in `viewerSpace`: by id and graph only when it is in that space. */
export function describeRoute(route: RouteRef, viewerSpace: string): string {
  return route.spaceSlug === viewerSpace
    ? `the API Route ${route.nodeId} on ${route.graphAddress}`
    : 'a route in another space'
}

function listed(routes: readonly RouteRef[], viewerSpace: string): string {
  return [...new Set(routes.map((route) => describeRoute(route, viewerSpace)))].join(', ')
}

const CHANGE_PATH = 'Change Route Path on one of them, or delete the route that should not have it.'

/** The error of `route`, which serves `path` while `others` also have it. */
export function pathHeldError(route: RouteRef, path: string, others: readonly RouteRef[]): NodeError {
  return {
    title: 'Another route has this path',
    code: PATH_ERROR_CODE.held,
    detail: `${path} is also the path of ${listed(others, route.spaceSlug)}. This route keeps serving it, and the other gets no requests.`,
    next: CHANGE_PATH,
  }
}

/** The error of `route`, which gets no requests because `holder` serves `path`. */
export function pathTakenError(route: RouteRef, path: string, holder: RouteRef): NodeError {
  return {
    title: 'Path taken by another route',
    code: PATH_ERROR_CODE.taken,
    detail: `${path} is served by ${describeRoute(holder, route.spaceSlug)}, so this route gets no requests.`,
    next: CHANGE_PATH,
  }
}

/** The error of `route`, sharing `path` with `others` when none of them serves it. */
export function pathSharedError(route: RouteRef, path: string, others: readonly RouteRef[]): NodeError {
  return {
    title: 'Path shared with another route',
    code: PATH_ERROR_CODE.shared,
    detail: `${path} is also the path of ${listed(others, route.spaceSlug)}, and none of them was serving it first, so every request to it gets 409.`,
    next: CHANGE_PATH,
  }
}
