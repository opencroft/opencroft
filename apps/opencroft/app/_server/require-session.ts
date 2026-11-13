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
//                                whatever external caller the user configured;
//                                a route can require its own header secret
//                                (api-route-access.ts)
//   /api/ext/<extensionId>/http/*
//                               an extension's own declared HTTP handler —
//                                "proxies, webhooks, SSE all work" is that
//                                file's own description of its job. A route
//                                the extension declares as a session route
//                                is gated, by dispatchExtensionRoute.
//
// Returns a 401 Response to short-circuit the handler, or null to continue.
export async function requireSession(request: Request): Promise<Response | null> {
  const user = await getSessionUser(request)
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

// requireSession for a route only an administrator may use: 401 with no
// session, 403 for a signed-in non-administrator, null to continue.
export async function requireAdminSession(request: Request): Promise<Response | null> {
  const denied = await requireSession(request)
  if (denied) return denied
  if (!(await requireAdminUser(request))) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

// Server functions do not use requireSession: every one of them runs the
// session gate registered in app/start.ts (server-fn-session-gate.ts) first.
//
// The admin seam for a server function whose admin requirement depends on its
// arguments: the request-facing dispatcher for an action an extension declared
// `admin`. A signed-in non-admin is authenticated but not authorized, so this
// THROWS a 403 Response, which the framework sends as the HTTP response
// (start-server-core's server-functions-handler). `requireAdminUser` RETURNS
// the admin or null rather than throwing, so the result must be acted on — a
// bare `await` with the value dropped type-checks and gates nothing.
export async function requireAdminServerFn(): Promise<void> {
  if (!(await requireAdminUser(getRequest()))) {
    throw Response.json({ error: 'Forbidden' }, { status: 403 })
  }
}
