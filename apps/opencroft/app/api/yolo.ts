import { createFileRoute } from '@tanstack/react-router'

import { getYoloModeInfo } from '@/app/_authed/(mcp)/_server/yolo'
import { requireSession } from '@/app/_server/require-session'

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
