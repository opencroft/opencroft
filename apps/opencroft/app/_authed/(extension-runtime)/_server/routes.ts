import { getSessionUser } from '@opencroft/auth/server'
import type { ExtensionRoute } from '@opencroft/server'

import { directoryUserOf } from '@/app/_server/user-directory'

// The methods a session route answers whichever site the request came from.
// Its handler must keep them free of changes (see ExtensionSessionRoute); every
// other method is refused from another origin below.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Answer one request for an extension's declared route: `routes[<path>]` of its
 * server module, served at `/api/ext/<scope>/<slug>/http/<path>`.
 *
 * A plain handler is public, as every extension route was before session
 * routes existed: webhooks and proxies depend on it.
 *
 * A `{ session: 'person', handler }` route is checked here, before the handler
 * runs, with the same `getSessionUser` the rest of the app uses. No session:
 * 401, and the handler never runs. A session: the handler gets the person in
 * the shape an App action gets as `callerPerson` (`directoryUserOf`).
 *
 * A session cookie is sent with requests from other sites under the same
 * domain too, so a request that could change something is refused when the
 * browser says it came from another origin (`Sec-Fetch-Site`). A client that
 * sends no such header is not a browser riding someone's cookie.
 *
 * Anything else declared under a route name fails closed with 500: a typo in
 * `session`, or a kind this host doesn't know, must not be served as public.
 */
export async function dispatchExtensionRoute(route: ExtensionRoute | undefined, request: Request): Promise<Response> {
  if (!route) {
    return new Response('Not found', { status: 404 })
  }
  if (typeof route === 'function') {
    return route(request)
  }
  if (route.session !== 'person' || typeof route.handler !== 'function') {
    return new Response('This route is declared in a form the host does not serve', { status: 500 })
  }
  const user = await getSessionUser(request)
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!SAFE_METHODS.has(request.method.toUpperCase())) {
    const site = request.headers.get('sec-fetch-site')
    if (site && site !== 'same-origin' && site !== 'none') {
      return Response.json({ error: 'Cross-site request refused' }, { status: 403 })
    }
  }
  return route.handler(request, { person: directoryUserOf(user) })
}
