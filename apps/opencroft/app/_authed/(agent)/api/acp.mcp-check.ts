import { createFileRoute } from '@tanstack/react-router'
import { checkMcpServer } from 'agent-client/mcp-check'
import type { McpServerConfig } from 'agent-client/mcp-types'

import { resolveMcpServerSecrets } from '@/app/_authed/(agent)/_server/mcp-store'
import { requireSession } from '@/app/_server/require-session'

// The body is the server config as it would be saved. `?agent=<node id>` names
// the agent the check is run for: a server that names a secret is checked with
// that agent's value, as that agent's session would mount it.
export const Route = createFileRoute('/_authed/(agent)/api/acp/mcp-check')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const config = (await request.json()) as McpServerConfig
        const agentNodeId = new URL(request.url).searchParams.get('agent')
        let resolved: McpServerConfig
        try {
          resolved = await resolveMcpServerSecrets(config, agentNodeId)
        } catch (err) {
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
        return Response.json(await checkMcpServer(resolved))
      },
    },
  },
})
