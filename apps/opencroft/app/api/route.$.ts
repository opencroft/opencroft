import { createFileRoute } from '@tanstack/react-router'

import { invokeExtensionAction } from '@/app/(extension-runtime)/_server/actions'
import { getStream } from '@/app/(extension-runtime)/_server/stream'
import { getSpacesRegistry } from '@/app/(space)/_server/store'

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

interface GraphEdge {
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

interface HandlerResult {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  error?: string
  logs?: string
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

    for (const node of runtime.graph.nodes as unknown as GraphNode[]) {
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

  // Find edges from the api-route node's exec-out handle
  const space = registry.getBySlug(matchedSpaceSlug)
  if (!space) {
    return Response.json({ error: 'Space not found' }, { status: 500 })
  }

  const handlerEdge = (space.graph.edges as unknown as GraphEdge[]).find(
    (e) => e.source === matchedRouteNode!.id && e.sourceHandle === 'exec-out',
  )

  if (!handlerEdge) {
    return Response.json({ error: 'API Route has no connected handler' }, { status: 502 })
  }

  // Find the target handler node
  const handlerNode = (space.graph.nodes as unknown as GraphNode[]).find((n) => n.id === handlerEdge.target)

  if (!handlerNode) {
    return Response.json({ error: 'Handler node not found' }, { status: 500 })
  }

  const language = handlerNode.data.language as string | undefined
  if (language !== 'python' && language !== 'node') {
    return Response.json(
      {
        error: `Unsupported handler language: ${language ?? 'none'}. Only Python and Node.js scripts support ExecutionContext.`,
      },
      { status: 400 },
    )
  }

  const resolvedContexts = handlerNode.data.__resolvedContexts as
    | Record<string, { value?: Record<string, unknown> }>
    | undefined
  const terminalContext = resolvedContexts?.['ctx-in']?.value ?? { type: 'local' }

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

  // Invoke handler.run server action
  try {
    const result = (await invokeExtensionAction({
      data: {
        extensionId: 'builtin/core',
        actionName: 'handler.run',
        args: [
          {
            script: handlerNode.data.script ?? '',
            language,
            context: terminalContext,
            event,
          },
        ],
      },
    })) as HandlerResult

    const stream = getStream<{ text: string; final: boolean }>(matchedSpaceSlug, handlerNode.id, 'stdout-out')
    if (result.logs) {
      stream.broadcast({ text: result.logs, final: false })
    }
    stream.broadcast({ text: '', final: true })

    if (result.error) {
      return Response.json({ error: result.error }, { status: result.status ?? 500 })
    }

    const status = result.status ?? 200
    const headers = result.headers ?? {}

    if (typeof result.body === 'object' && result.body !== null) {
      return Response.json(result.body, { status, headers })
    }

    return new Response(String(result.body ?? ''), {
      status,
      headers: {
        'content-type': 'text/plain',
        ...headers,
      },
    })
  } catch (err) {
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
