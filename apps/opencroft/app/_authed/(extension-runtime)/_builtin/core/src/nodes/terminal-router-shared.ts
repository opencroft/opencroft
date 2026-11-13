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

/** The node a "node-id/handle-id" target names, or '' for a string that is not a target. */
export function targetNodeId(target: string): string {
  const slash = target.indexOf('/')
  return slash > 0 && slash < target.length - 1 ? target.slice(0, slash) : ''
}

/**
 * The routes of `data` that point at a route of a Terminal Router, told which
 * node ids are routers. A route reaches a terminal, never another route, so
 * what a route names is always where its terminal lives.
 */
export function routesToRoutes(data: TerminalRouterData, isRouter: (nodeId: string) => boolean): TerminalRoute[] {
  return (data.routes ?? []).filter((route) => {
    const nodeId = typeof route?.target === 'string' ? targetNodeId(route.target) : ''
    return nodeId !== '' && isRouter(nodeId)
  })
}

/** Why a route to `target`, a route of the router `routerId`, is refused. */
export function routeToRouteText(target: string, routerId: string, reaches?: string): string {
  const instead = reaches ? `the terminal it reaches (${reaches})` : 'the terminal it reaches'
  return `${target} is a route of the Terminal Router ${routerId}. A route cannot point at another route: route to ${instead} instead.`
}

/** What `terminalRouter.resolve` answers for a target the inspector adds. */
export type TerminalRouteResolution = { context: unknown } | { refused: string }

function routeOf(handleId: string, data: TerminalRouterData): TerminalRoute | undefined {
  if (!handleId.startsWith(ROUTE_HANDLE_PREFIX)) {
    return undefined
  }
  return data.routes?.find((r) => routeHandleId(r) === handleId)
}

/** The context a route output carries, or undefined for an unknown or unresolved route. */
export function routeOutput(handleId: string, data: TerminalRouterData): unknown {
  return routeOf(handleId, data)?.context ?? undefined
}

/** The target a route output reaches, or undefined for an unknown route. */
export function routeTarget(handleId: string, data: TerminalRouterData): string | undefined {
  return routeOf(handleId, data)?.target
}
