import { createFileRoute } from '@tanstack/react-router'
import { readMcpConfig, writeMcpConfig } from 'agent-client/mcp-config'
import type { McpServerConfig } from 'agent-client/mcp-types'
import { agentClient } from '@/app/(agent)/_server/agent-client-instance'

// Global MCP server config, shared by all local agents (agent-client reads it
// from mcp-config.json in the app cwd). Saving refreshes live sessions.
export const Route = createFileRoute('/(agent)/api/acp/mcp')({
  server: {
    handlers: {
      GET: async () => Response.json(await readMcpConfig()),
      POST: async ({ request }) => {
        const servers = (await request.json()) as McpServerConfig[]
        await writeMcpConfig(servers)
        await agentClient.refreshMcpServers()
        return Response.json({ ok: true })
      },
    },
  },
})
