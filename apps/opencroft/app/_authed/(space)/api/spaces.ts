import { createFileRoute } from '@tanstack/react-router'

import { requireSession } from '@/app/_server/require-session'
import { createSpace, listSpaces } from '@/app/_authed/(space)/_server/actions'

export const Route = createFileRoute('/_authed/(space)/api/spaces')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const spaces = await listSpaces()
        return Response.json({ spaces })
      },
      POST: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const body = (await request.json()) as { name?: string }
        const name = body.name ?? 'Space'
        const space = await createSpace({ data: name })
        return Response.json({ space }, { status: 201 })
      },
    },
  },
})
