import { createFileRoute } from '@tanstack/react-router'
import type { McpServerConfig } from 'agent-client/mcp-types'
import { agentClient } from '@/app/(agent)/_server/agent-client-instance'
import { readMcpServers, writeMcpServers } from '@/app/(agent)/_server/mcp-store'

// Global MCP server list, shared by all local agents and stored in the settings
// DB (not on disk). Saving refreshes live sessions.
export const Route = createFileRoute('/(agent)/api/acp/mcp')({
  server: {
    handlers: {
      GET: async () => Response.json(await readMcpServers()),
      POST: async ({ request }) => {
        const servers = (await request.json()) as McpServerConfig[]
        await writeMcpServers(servers)
        await agentClient.refreshMcpServers()
        return Response.json({ ok: true })
      },
    },
  },
})
