import { createFileRoute } from '@tanstack/react-router'

import { checkMcpServer } from 'agent-client/mcp-check'
import type { McpServerConfig } from 'agent-client/mcp-types'

export const Route = createFileRoute('/(agent)/api/acp/mcp-check')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const config = (await request.json()) as McpServerConfig
        return Response.json(await checkMcpServer(config))
      },
    },
  },
})
