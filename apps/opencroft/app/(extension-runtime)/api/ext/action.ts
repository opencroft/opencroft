import { createFileRoute } from '@tanstack/react-router'

import { invokeExtensionAction } from '@/app/(extension-runtime)/_server/actions'

export const Route = createFileRoute('/(extension-runtime)/api/ext/action')({
  server: {
    handlers: {
      POST: async ({ request }) => {
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
