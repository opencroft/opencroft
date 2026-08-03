import { getSessionUser } from '@opencroft/auth/server'

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
// NOT applied to every /api/* route. Two categories are excluded on purpose,
// and gating them would be a real regression, not caution:
//
//   /api/mcp                    bearer-token surface, not a
//                                session one — session and token answer
//                                different questions, see caller.ts
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
