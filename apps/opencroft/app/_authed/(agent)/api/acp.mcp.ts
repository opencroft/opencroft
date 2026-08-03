import { createFileRoute } from '@tanstack/react-router'
import type { McpServerConfig } from 'agent-client/mcp-types'

import { requireSession } from '@/app/_server/require-session'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { readMcpServers, writeMcpServers } from '@/app/_authed/(agent)/_server/mcp-store'

// Global MCP server list, shared by all local agents and stored in the settings
// DB (not on disk). Saving refreshes live sessions.
export const Route = createFileRoute('/_authed/(agent)/api/acp/mcp')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        return Response.json(await readMcpServers())
      },
      POST: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const servers = (await request.json()) as McpServerConfig[]
        await writeMcpServers(servers)
        await agentClient.refreshMcpServers()
        return Response.json({ ok: true })
      },
    },
  },
})
