import { createAgentClient, type PermissionContext, type PermissionOutcome } from 'agent-client/agent-client'

import { readMcpServers } from '@/app/(agent)/_server/mcp-store'
import { isYoloMode } from '@/app/(mcp)/_server/yolo'
import { approvalStore } from '@/lib/approval-store'

// Single shared agent-client engine for the opencroft app. Every ACP route and
// the SSE stream import this one instance so they share the session store.
//
// We register opencroft's own MCP server (graph + remote-exec tools, etc.) as an
// always-on MCP server, so every local agent can call the same tools opencroft
// exposes. Override the URL via OPENCROFT_MCP_URL when not on the dev port.
//
// The x-opencroft-internal header marks these calls as coming from the internal
// agent: they bypass the MCP approval queue (the agent chat has its own
// permission flow) instead of appearing in the MCP Requests inspector tab.
const OPENCROFT_MCP_URL = process.env.OPENCROFT_MCP_URL ?? 'http://127.0.0.1:9999/api/mcp'

// ACP tool-call kinds that only read state — safe to auto-approve so the chat
// only prompts for write/exec kinds (the destructive operations).
const READONLY_KINDS = new Set(['read', 'search', 'fetch', 'think'])

// Decide each ACP permission request against the global approval mode:
//   YOLO        → bypass approvals entirely.
//   Auto-approve → approve every request.
//   Default      → auto-approve read-only kinds, prompt for the rest.
function resolvePermission({ toolKind }: PermissionContext): PermissionOutcome {
  if (isYoloMode() || approvalStore.getAutoApprove()) {
    return 'allow'
  }
  return toolKind && READONLY_KINDS.has(toolKind) ? 'allow' : 'prompt'
}

export const agentClient = createAgentClient({
  extraMcpServers: [
    {
      type: 'http',
      name: 'opencroft',
      url: OPENCROFT_MCP_URL,
      headers: [{ name: 'x-opencroft-internal', value: '1' }],
    },
  ],
  loadMcpServers: readMcpServers,
  permissionHandler: resolvePermission,
})
