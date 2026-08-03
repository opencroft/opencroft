import { createFileRoute } from '@tanstack/react-router'

import { requireSession } from '@/app/_server/require-session'
import { getYoloModeInfo } from '@/app/_authed/(mcp)/_server/yolo'

export const Route = createFileRoute('/api/yolo')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const info = getYoloModeInfo()
        return Response.json(info)
      },
    },
  },
})
