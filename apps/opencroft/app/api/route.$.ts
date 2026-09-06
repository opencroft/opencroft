import { createFileRoute } from '@tanstack/react-router'

import { dispatchExecutionContext, NoExecTargetError } from '@/app/_authed/(extension-runtime)/_server/exec-dispatch'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// ═══════════════════════════════════════════════════════════════════
// Path matching — simple :param syntax
// ═══════════════════════════════════════════════════════════════════

interface MatchResult {
  matched: boolean
  params: Record<string, string>
}

function matchPath(pattern: string, actual: string): MatchResult {
  const patternParts = pattern.replace(/^\/+|\/+$/g, '').split('/')
  const actualParts = actual.replace(/^\/+|\/+$/g, '').split('/')
  const params: Record<string, string> = {}

  if (patternParts.length !== actualParts.length) {
    return { matched: false, params: {} }
  }

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]
    const a = actualParts[i]
    if (p.startsWith(':')) {
      params[p.slice(1)] = a
    } else if (p !== a) {
      return { matched: false, params: {} }
    }
  }

  return { matched: true, params }
}

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

interface GraphNode {
  id: string
  type?: string
  data: Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════════
// Route handler
// ═══════════════════════════════════════════════════════════════════

async function handleRequest(request: Request, params: { _splat?: string }) {
  const pathSegments = (params._splat ?? '').split('/').filter(Boolean)
  const requestPath = '/' + pathSegments.join('/')
  const method = request.method

  // Load all spaces and find api-route nodes
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()

  let matchedRouteNode: GraphNode | null = null
  let matchedSpaceSlug: string | null = null
  let matchedParams: Record<string, string> = {}

  for (const space of registry.list()) {
    const runtime = registry.getBySlug(space.slug)
    if (!runtime) {
      continue
    }

    const spaceNodes = [...runtime.graphs.values()].flatMap((g) => g.graph.nodes)
    for (const node of spaceNodes as unknown as GraphNode[]) {
      if (node.type !== 'api-route') {
        continue
      }

      const nodePath = (node.data.path as string) ?? '/'

      const result = matchPath(nodePath, requestPath)
      if (result.matched) {
        matchedRouteNode = node
        matchedSpaceSlug = space.slug
        matchedParams = result.params
        break
      }
    }

    if (matchedRouteNode) {
      break
    }
  }

  if (!matchedRouteNode || !matchedSpaceSlug) {
    return Response.json({ error: 'Not Found' }, { status: 404 })
  }

  const rawMethods = matchedRouteNode.data.methods ?? matchedRouteNode.data.method ?? ['GET']
  const allowedMethods = (Array.isArray(rawMethods) ? rawMethods : [rawMethods]) as string[]
  if (!allowedMethods.includes(method)) {
    return Response.json(
      { error: 'Method Not Allowed' },
      { status: 405, headers: { Allow: allowedMethods.join(', ') } },
    )
  }

  // Build request event
  let body: unknown
  const contentType = request.headers.get('content-type')
  if (contentType?.includes('application/json')) {
    try {
      body = await request.json()
    } catch {
      // ignore parse errors
    }
  } else if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.text()
  }

  const url = new URL(request.url)
  const event = {
    method,
    path: requestPath,
    params: matchedParams,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: Object.fromEntries(request.headers.entries()),
    body,
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
