import { defineEventHandler } from 'nitro/h3'

import { getExtensionModule } from '@/app/_authed/(extension-runtime)/_server/loader'
import { extRouteParams } from '@/app/_authed/(extension-runtime)/_server/route-params'
import { ensureServerStarted } from '@/server/startup'

// Dispatches to an HTTP handler exposed by the extension's server module as
// `routes[<path>]`. The handler receives the raw Request and returns a (possibly
// streaming) Response — proxies, webhooks, SSE all work. In the Nitro serverDir
// so arbitrary (often dotted) proxy paths reach the handler in dev too.
export default defineEventHandler(async (event) => {
  // A webhook can deliver into a thread, and it may be the first request this
  // process receives.
  await ensureServerStarted()
  const { scope, slug, path: splat } = extRouteParams(event)
  const extensionId = `${scope}/${slug}`
  const routeKey = (splat ?? '').split('/').filter(Boolean).join('/')
  let mod
  try {
    mod = await getExtensionModule(extensionId)
  } catch (err) {
    return new Response(String(err), { status: 500 })
  }
  const handler = mod.routes?.[routeKey]
  if (!handler) {
    return new Response('Not found', { status: 404 })
  }
  return handler(event.req)
})
