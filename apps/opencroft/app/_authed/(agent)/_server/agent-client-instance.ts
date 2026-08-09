import { createAgentClient, type PermissionContext, type PermissionOutcome } from 'agent-client/agent-client'
import type { ChatEvent } from 'agent-client/types'

import { writePersistedUsage } from '@/app/_authed/(agent)/_server/acp-session-store'
import { readMcpServersForAgent } from '@/app/_authed/(agent)/_server/mcp-store'
import { loadSkillDefs, skillBodyHandler } from '@/app/_authed/(agent)/_server/skill-store'
import { opencroftLocalTools } from '@/app/_authed/(agent)/_server/tools-bridge'
import { stampDeliveryTime } from '@/app/_authed/(agent)/_shared/message-envelope'
import { isYoloMode } from '@/app/_authed/(mcp)/_server/yolo'
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

// Last context usage seen per session, snapshotted when a turn ends so a
// resumed session can be seeded with it (see readPersistedUsage's note on why
// ACP gives no way to ask an agent for this).
//
// Written on `turn_end` rather than on every `usage` event: an agent reports
// usage repeatedly while a turn streams, and each write is a read-modify-write
// against one shared settings row. Once per turn is one write per exchange and
// records the figure that actually matters — what the session holds now that
// the turn is over. A session unloaded or a process killed mid-turn simply
// keeps the previous turn's value, which is the correct conservative answer.
function persistUsageOnTurnEnd(sessionId: string, event: ChatEvent): void {
  if (event.kind !== 'turn_end') {
    return
  }
  const usage = agentClient.listSessions().find((s) => s.id === sessionId)?.usage
  if (!usage) {
    return
  }
  // Fire-and-forget: an event observer must not hold up the emit, and a failed
  // write only costs a blank ring on the next cold open.
  void writePersistedUsage(sessionId, usage).catch((error) => {
    console.error('Failed to persist context usage for session', sessionId, error)
  })
}

export const agentClient = createAgentClient({
  tools: opencroftLocalTools,
  loadMcpServers: readMcpServersForAgent,
  // Global skill catalog from the settings DB, resolved per turn. For now every
  // configured skill is exposed to this agent client (not scoped per node).
  skills: loadSkillDefs,
  skillHandler: skillBodyHandler,
  permissionHandler: resolvePermission,
  transformDeliveredPrompt: (text) => stampDeliveryTime(text, new Date()),
  onEvent: persistUsageOnTurnEnd,
})
