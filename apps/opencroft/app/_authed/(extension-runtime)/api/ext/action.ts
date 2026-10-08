import { createFileRoute } from '@tanstack/react-router'

import { invokeExtensionAction } from '@/app/_authed/(extension-runtime)/_server/actions'
import { requireSession } from '@/app/_server/require-session'

// No caller found anywhere in this app or in any built-in extension's source
// — checked before gating rather than assumed. Session-gated regardless: an
// unauthenticated arbitrary-action invoker costs nothing to close even though
// nothing currently reaches it, and a route that answers is a route someone
// can find later.
export const Route = createFileRoute('/_authed/(extension-runtime)/api/ext/action')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        const { extensionId, action, args } = body as {
          extensionId?: string
          action?: string
          args?: unknown[]
        }

        if (!extensionId || !action) {
          return Response.json({ error: 'Missing extensionId or action' }, { status: 400 })
        }

        try {
          const result = await invokeExtensionAction({ data: { extensionId, actionName: action, args: args ?? [] } })
          return Response.json({ ok: true, result })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return Response.json({ error: message }, { status: 500 })
        }
      },
    },
  },
})
