import { createFileRoute } from '@tanstack/react-router'

import { requireSession } from '@/app/_server/require-session'
import { getActiveSpaceSlug, setActiveSpaceSlug } from '@/app/(space)/_server/actions'

export const Route = createFileRoute('/(space)/api/spaces/active')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const slug = await getActiveSpaceSlug()
        return Response.json({ slug })
      },
      PUT: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const body = (await request.json()) as { slug?: string }
        if (!body.slug) {
          return Response.json({ error: 'Missing slug' }, { status: 400 })
        }
        await setActiveSpaceSlug({ data: body.slug })
        return Response.json({ ok: true })
      },
    },
  },
})
