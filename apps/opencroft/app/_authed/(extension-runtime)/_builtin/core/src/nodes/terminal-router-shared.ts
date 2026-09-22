// The Terminal Router's data shape and output resolution, free of the client
// runtime so the core server module and the host's graph resolution read the
// same definition the node renders from.

export const TERMINAL_ROUTER_TYPE = 'terminal-router'

/** Declared id of the router's dynamic outputs; each route's handle is this plus its id. */
export const ROUTE_HANDLE_PREFIX = 'route-'

export interface TerminalRoute {
  /** Stable per route, so removing one route leaves the other routes' edges on their handles. */
  id: string
  /** "node-id/handle-id" of the routed terminal source. */
  target: string
  /** Display name as the TerminalSelector offered it. */
  title: string
  /**
   * The target's terminal context as last resolved. exposeOutput is synchronous
   * and sees only this node's data, so the value is carried here: set by the
   * inspector when the route is added, re-resolved server-side on every graph
   * resolution, and absent while the target does not resolve.
   */
  context?: unknown
}

export interface TerminalRouterData {
  name?: string
  routes?: TerminalRoute[]
}

export function routeHandleId(route: Pick<TerminalRoute, 'id'>): string {
  return `${ROUTE_HANDLE_PREFIX}${route.id}`
}

/** The context a route output carries, or undefined for an unknown or unresolved route. */
export function routeOutput(handleId: string, data: TerminalRouterData): unknown {
  if (!handleId.startsWith(ROUTE_HANDLE_PREFIX)) {
    return undefined
  }
  const route = data.routes?.find((r) => routeHandleId(r) === handleId)
  return route?.context ?? undefined
}
