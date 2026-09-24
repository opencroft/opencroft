import { getSessionUser, requireAdminUser } from '@opencroft/auth/server'
import { getRequest } from '@tanstack/react-start/server'

// Shared session gate for the browser-driven API routes named in
// __root.tsx's boundary comment. These are TanStack
// server route handlers, not client components, so this file is never part
// of the client bundle regardless of what it exports; unlike token-actions.ts
// or session.ts, there is no "every export must be a createServerFn" rule
// to observe here.
//
// This is deliberately the SAME getSessionUser the root page boundary and the
// terminal websocket both use — one seam answering "who is this", not a third
// mechanism to keep in sync with the other two.
//
// NOT applied to every route. Three are excluded on purpose, and gating them
// would be a real regression, not caution:
//
//   /mcp                        the MCP endpoint, gated by an MCP token instead
//                                — session and token answer different
//                                questions, see caller.ts
//   /api/route/$                a user's own "API Route" canvas node: the
//                                whole feature is being a webhook target for
//                                whatever external caller the user configured
//   /api/ext/.../http/[...path] an extension's own declared HTTP handler —
//                                "proxies, webhooks, SSE all work" is that
//                                file's own description of its job
//
// Returns a 401 Response to short-circuit the handler, or null to continue.
export async function requireSession(request: Request): Promise<Response | null> {
  const user = await getSessionUser(request)
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

// Session gate for a createServerFn handler. A server function is its own
// callable HTTP endpoint, reachable without going through the page that leads
// to it, so the route-level gate in _authed.tsx does not cover it — a handler
// that must not answer an anonymous caller awaits this first. Unlike
// requireSession above, which a route handler calls with the request and
// returns the 401 to, a server function has nowhere to return a Response, so
// this THROWS one: the framework sends a thrown Response as the HTTP response
// (start-server-core's server-functions-handler), which is what makes the
// status a real 401 rather than a serialized error inside a 200.
export async function requireSessionServerFn(): Promise<void> {
  if (!(await getSessionUser(getRequest()))) {
    throw Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

// The same seam for an admin-only server function: layered after
// requireSessionServerFn by the request-facing dispatcher for an action an
// extension declared `admin`. A signed-in non-admin is authenticated but not
// authorized, so this is a 403, not a 401. `requireAdminUser` RETURNS the admin
// or null rather than throwing, so the result must be acted on — a bare `await`
// with the value dropped type-checks and gates nothing.
export async function requireAdminServerFn(): Promise<void> {
  if (!(await requireAdminUser(getRequest()))) {
    throw Response.json({ error: 'Forbidden' }, { status: 403 })
  }
}
