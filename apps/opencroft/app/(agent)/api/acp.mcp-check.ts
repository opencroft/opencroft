import { createFileRoute } from '@tanstack/react-router'
import { checkMcpServer } from 'agent-client/mcp-check'
import type { McpServerConfig } from 'agent-client/mcp-types'

import { requireSession } from '@/app/_server/require-session'

export const Route = createFileRoute('/(agent)/api/acp/mcp-check')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const config = (await request.json()) as McpServerConfig
        return Response.json(await checkMcpServer(config))
      },
    },
  },
})
