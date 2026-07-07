import { createAgentClient, type PermissionContext, type PermissionOutcome } from 'agent-client/agent-client'

import { readMcpServers } from '@/app/(agent)/_server/mcp-store'
import { loadSkillDefs, skillBodyHandler } from '@/app/(agent)/_server/skill-store'
import { opencroftLocalTools } from '@/app/(agent)/_server/tools-bridge'
import { isYoloMode } from '@/app/(mcp)/_server/yolo'
import { approvalStore } from '@/lib/approval-store'

// Single shared agent-client engine for the opencroft app. Every ACP route and
// the SSE stream import this one instance so they share the session store.
//
// opencroft's own tools (graph + remote-exec + extensions + docs + MCP config +
// skills — see tools-bridge.ts) are wired in-process via `tools`, exposed
// through agent-client's built-in 'local' MCP server (ACP harness path) and
// directly in the native harness's toolset. There is no network hop back into
// this same process's /api/mcp route for the agent's own tool calls, so the
// container-reachability bug class that route needed a URL rewrite to work
// around doesn't apply to these tools at all. /api/mcp itself is unchanged and
// still serves genuinely external MCP clients.
//
// Calls made through this bridge are marked internal (see tools-bridge.ts):
// they bypass the MCP approval queue (the agent chat has its own permission
// flow) instead of appearing in the MCP Requests inspector tab.

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
  tools: opencroftLocalTools,
  loadMcpServers: readMcpServers,
  // Global skill catalog from the settings DB, resolved per turn. For now every
  // configured skill is exposed to this agent client (not scoped per node).
  skills: loadSkillDefs,
  skillHandler: skillBodyHandler,
  permissionHandler: resolvePermission,
})
