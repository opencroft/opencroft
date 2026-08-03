import { createFileRoute } from '@tanstack/react-router'

import { requireSession } from '@/app/_server/require-session'
import { exportSpace } from '@/app/(space)/_server/actions'

export const Route = createFileRoute('/(space)/api/spaces/$slug/export')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const { slug } = params
        const data = await exportSpace({ data: slug })
        if (!data) {
          return Response.json({ error: 'Space not found' }, { status: 404 })
        }
        return new Response(JSON.stringify(data, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="space-${slug}.json"`,
          },
        })
      },
    },
  },
})
