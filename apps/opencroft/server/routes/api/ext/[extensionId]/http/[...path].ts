import { defineEventHandler } from 'nitro/h3'

import { getExtensionModule } from '@/app/_authed/(extension-runtime)/_server/loader'
import { extRouteParams } from '@/app/_authed/(extension-runtime)/_server/route-params'
import { dispatchExtensionRoute } from '@/app/_authed/(extension-runtime)/_server/routes'
import { ensureServerStarted } from '@/server/startup'

// Dispatches to an HTTP route exposed by the extension's server module as
// `routes[<path>]`. The handler receives the raw Request and returns a (possibly
// streaming) Response — proxies, webhooks, SSE all work. A route is public
// unless the extension declared it as a session route; dispatchExtensionRoute
// decides which. In the Nitro serverDir so arbitrary (often dotted) proxy paths
// reach the handler in dev too.
export default defineEventHandler(async (event) => {
  // A webhook can deliver into a thread, and it may be the first request this
  // process receives.
  await ensureServerStarted()
  const params = await extRouteParams(event)
  if (!params) {
    return new Response('Not found', { status: 404 })
  }
  const { extensionId, path: splat } = params
  const routeKey = (splat ?? '').split('/').filter(Boolean).join('/')
  let mod
  try {
    mod = await getExtensionModule(extensionId)
  } catch (err) {
    return new Response(String(err), { status: 500 })
  }
  return dispatchExtensionRoute(mod.routes?.[routeKey], event.req)
})
