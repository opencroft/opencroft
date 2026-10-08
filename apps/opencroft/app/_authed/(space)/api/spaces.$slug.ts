import { createFileRoute } from '@tanstack/react-router'

import { deleteSpace, loadSpaceGraph, renameSpace } from '@/app/_authed/(space)/_server/actions'
import { requireSession } from '@/app/_server/require-session'

export const Route = createFileRoute('/_authed/(space)/api/spaces/$slug')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const { slug } = params
        const result = await loadSpaceGraph({ data: slug })
        if (!result) {
          return Response.json({ error: 'Space not found' }, { status: 404 })
        }
        return Response.json(result)
      },
      PATCH: async ({ request, params }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const { slug } = params
        const body = (await request.json()) as { name?: string }
        if (!body.name) {
          return Response.json({ error: 'Missing name' }, { status: 400 })
        }
        const space = await renameSpace({ data: { slug, name: body.name } })
        if (!space) {
          return Response.json({ error: 'Space not found' }, { status: 404 })
        }
        return Response.json({ space })
      },
      DELETE: async ({ request, params }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const { slug } = params
        const ok = await deleteSpace({ data: slug })
        if (!ok) {
          return Response.json({ error: 'Cannot delete' }, { status: 400 })
        }
        return Response.json({ ok: true })
      },
    },
  },
})
