import type { HostUser } from './host'

/**
 * A public HTTP handler, served at `<urlBase>/http/<path>`, where `urlBase`
 * is `/api/ext/<extensionId>` (build a link to it with `routeUrl`). It
 * receives the raw Request and returns a (possibly streaming) Response, which
 * suits proxies, webhooks and SSE. Anyone who can reach the server can call it.
 */
export type ExtensionRouteHandler = (request: Request) => Response | Promise<Response>

/** Who called a session route. Bound by the host from the session; the extension never reads the cookie. */
export interface ExtensionRouteContext {
  /** The signed-in person: the same `HostUser` an App action receives as `callerPerson`. */
  person: HostUser
}

/**
 * A route only a signed-in person reaches. The host checks the session before
 * the handler runs: without one the request is answered 401 and the handler
 * never runs. A browser request sent from another site is refused with 403
 * too, unless its method is GET, HEAD or OPTIONS, so the handler must keep
 * those three free of changes.
 *
 * The host says only WHO is asking. Whether that person may see or change
 * what the route serves is the extension's check, as it is for App actions.
 */
export interface ExtensionSessionRoute {
  session: 'person'
  handler: (request: Request, context: ExtensionRouteContext) => Response | Promise<Response>
}

export type ExtensionRoute = ExtensionRouteHandler | ExtensionSessionRoute

/**
 * Route path → route, exported as `routes` from an extension's server module.
 * The path is matched exactly; a handler reads anything variable from the
 * query string.
 */
export type ExtensionRoutes = Record<string, ExtensionRoute>
