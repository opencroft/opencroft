import { createAgentClient, type PermissionContext, type PermissionOutcome } from 'agent-client/agent-client'
import type { ChatEvent } from 'agent-client/types'

import { readPersistedPresence, writePersistedUsage } from '@/app/_authed/(agent)/_server/acp-session-store'
import { readMcpServersForAgent } from '@/app/_authed/(agent)/_server/mcp-store'
import { queueStore } from '@/app/_authed/(agent)/_server/queue-store'
import { loadSkillDefs, skillBodyHandler } from '@/app/_authed/(agent)/_server/skill-store'
import { opencroftLocalTools } from '@/app/_authed/(agent)/_server/tools-bridge'
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

// A session reopens at the cadence it was reading at, and this is resolved
// BEFORE its restored queue is evaluated (see agent-client's restore). Without
// that ordering an hourly session would hand over everything it had been
// holding the moment it reopened — the restart becoming the interruption the
// setting exists to prevent, with nothing able to un-deliver it afterwards.
async function loadPresence(sessionKey: string) {
  try {
    return (await readPersistedPresence(sessionKey)) ?? undefined
  } catch (error) {
    // Undefined leaves the engine's own default in place. Reading early is the
    // safe direction for a setting that decides whether a message arrives.
    console.error('Failed to read persisted presence for session key', sessionKey, error)
    return undefined
  }
}

export const agentClient = createAgentClient({
  tools: opencroftLocalTools,
  loadMcpServers: readMcpServersForAgent,
  // Durable copy of the queue. Written behind the in-memory one and never read
  // to make a decision — see QueueStore.
  queueStore,
  loadPresence,
  // Global skill catalog from the settings DB, resolved per turn. For now every
  // configured skill is exposed to this agent client (not scoped per node).
  skills: loadSkillDefs,
  skillHandler: skillBodyHandler,
  permissionHandler: resolvePermission,
  // No `transformDeliveredPrompt`. A delivery-time stamp used to be prefixed
  // here; it was removed because every message already carries `datetime` on
  // its own tag, in ISO 8601 with an explicit zone, while the stamp was
  // day-first and zoneless -- so of the two timestamps an agent received, the
  // redundant one was the ambiguous one.
  //
  // The extension point itself stays in agent-client: it is a host-agnostic
  // seam in a shared package, and this product no longer using it is not a
  // reason to take it from one that might.
  onEvent: persistUsageOnTurnEnd,
})
