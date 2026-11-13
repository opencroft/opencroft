import { createFileRoute } from '@tanstack/react-router'

import { checkRouteAccess } from '@/app/_authed/(extension-runtime)/_server/api-route-access'
import { requestBody } from '@/app/_authed/(extension-runtime)/_server/api-route-body'
import { instanceRouteTable } from '@/app/_authed/(extension-runtime)/_server/api-route-claims'
import { matchRoute } from '@/app/_authed/(extension-runtime)/_server/api-route-table'
import { dispatchExecutionContext, NoExecTargetError } from '@/app/_authed/(extension-runtime)/_server/exec-dispatch'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// ═══════════════════════════════════════════════════════════════════
// Route handler
// ═══════════════════════════════════════════════════════════════════

// A path belongs to one route on the instance (`api-route-claims.ts`).
async function handleRequest(request: Request, params: { _splat?: string }) {
  const pathSegments = (params._splat ?? '').split('/').filter(Boolean)
  const requestPath = `/${pathSegments.join('/')}`
  const method = request.method

  const registry = getSpacesRegistry()
  await registry.ensureLoaded()

  const match = matchRoute(instanceRouteTable(), requestPath)
  if (match.kind === 'none') {
    return Response.json({ error: 'Not Found' }, { status: 404 })
  }
  // No route of those sharing the path takes its requests, nor any header
  // meant for one of them.
  if (match.kind === 'shared') {
    return Response.json({ error: 'More than one route has this path' }, { status: 409 })
  }
  const matchedRouteNode = { id: match.route.nodeId, data: match.route.data }
  const matchedParams = match.params

  // Before anything else about the route is answered: a caller without the
  // required header learns neither its methods nor how it handles a body.
  const access = await checkRouteAccess(matchedRouteNode.id, matchedRouteNode.data, request.headers)
  if (!access.allowed) {
    return access.response
  }

  const rawMethods = matchedRouteNode.data.methods ?? matchedRouteNode.data.method ?? ['GET']
  const allowedMethods = (Array.isArray(rawMethods) ? rawMethods : [rawMethods]) as string[]
  if (!allowedMethods.includes(method)) {
    return Response.json(
      { error: 'Method Not Allowed' },
      { status: 405, headers: { Allow: allowedMethods.join(', ') } },
    )
  }

  // Build request event; `text` is what the route's Text output carries.
  const { body, text } = await requestBody(request)
  const url = new URL(request.url)
  const event = {
    method,
    path: requestPath,
    params: matchedParams,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: access.headers,
    body,
    ...(text === undefined ? {} : { text }),
  }

  // Dispatch to every target connected to the route's exec-out handle;
  // the primary target's result becomes the HTTP response.
  try {
    const { primary } = await dispatchExecutionContext({
      sourceNodeId: matchedRouteNode.id,
      sourceHandleId: 'exec-out',
      event,
    })

    if (primary.error) {
      return Response.json({ error: primary.error }, { status: primary.status ?? 500 })
    }

    const status = primary.status ?? 200
    const headers = primary.headers ?? {}

    if (typeof primary.body === 'object' && primary.body !== null) {
      return Response.json(primary.body, { status, headers })
    }

    return new Response(String(primary.body ?? ''), {
      status,
      headers: {
        'content-type': 'text/plain',
        ...headers,
      },
    })
  } catch (err) {
    if (err instanceof NoExecTargetError) {
      return Response.json({ error: 'API Route has no connected handler' }, { status: 502 })
    }
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 500 })
  }
}

export const Route = createFileRoute('/api/route/$')({
  server: {
    handlers: {
      GET: ({ request, params }) => handleRequest(request, params),
      POST: ({ request, params }) => handleRequest(request, params),
      PUT: ({ request, params }) => handleRequest(request, params),
      PATCH: ({ request, params }) => handleRequest(request, params),
      DELETE: ({ request, params }) => handleRequest(request, params),
      HEAD: ({ request, params }) => handleRequest(request, params),
      OPTIONS: ({ request, params }) => handleRequest(request, params),
    },
  },
})
