import { join } from 'node:path'

import { createAgentClient, type PermissionContext, type PermissionOutcome } from 'agent-client/agent-client'
import type { ChatEvent, CompactionState } from 'agent-client/types'

import { readPersistedPresence, writePersistedUsage } from '@/app/_authed/(agent)/_server/acp-session-store'
import { loadAttachments } from '@/app/_authed/(agent)/_server/attachment-store'
import { recordChatUsageTurn } from '@/app/_authed/(agent)/_server/chat-usage-store'
import { readMcpServersForAgent } from '@/app/_authed/(agent)/_server/mcp-store'
import { queueStore } from '@/app/_authed/(agent)/_server/queue-store'
import { appendSessionEvent } from '@/app/_authed/(agent)/_server/session-event-store'
import { loadSkillDefs, skillBodyHandler } from '@/app/_authed/(agent)/_server/skill-store'
import { toolPermissionOutcome } from '@/app/_authed/(agent)/_server/tool-permission'
import { opencroftLocalTools } from '@/app/_authed/(agent)/_server/tools-bridge'
import { stopHostTaskOption } from '@/app/_authed/(background-tasks)/_server/engine'
import { backgroundTasks } from '@/app/_authed/(background-tasks)/_server/service'
import { isSleepMode, subscribeSleepMode } from '@/app/_authed/(mcp)/_server/sleep-mode'
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

// Decide each ACP permission request against the global approval mode:
//   YOLO        → bypass approvals entirely.
//   Auto-approve → approve every request.
//   Default      → decide on the tool itself (see tool-permission.ts), which
//                  is this app's own classification rather than the kind the
//                  request happened to arrive with.
function resolvePermission(context: PermissionContext): PermissionOutcome {
  if (isYoloMode() || approvalStore.getAutoApprove()) {
    return 'allow'
  }
  return toolPermissionOutcome(context)
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
// Everything a session emits, recorded under the key that outlives it, so a
// reopened chat is rebuilt from what was actually shown rather than from what
// the agent's own history replay happens to carry. See session-event-store for
// the batching, and agent-client's restoreSession for what reads it back.
//
// Every kind, deliberately: a snapshot event is cheap, the read side already
// folds the last one seen per kind, and deciding here which kinds "matter"
// would be this file holding a second opinion about the transcript's shape.
function persistSessionEvent(event: ChatEvent, sessionKey: string | undefined): void {
  if (!sessionKey) {
    // Nothing could address the rows later — the same reason the durable queue
    // skips a keyless session.
    return
  }
  appendSessionEvent(sessionKey, event)
}

function persistUsageOnTurnEnd(sessionId: string, event: ChatEvent, sessionKey: string | undefined): void {
  if (event.kind !== 'turn_end') {
    return
  }
  // The turn's own spend, when the harness reported one — written as a row
  // into ChatUsageTurn, the accounting record behind any later day/agent/model
  // aggregation (see chat-usage-store). adapterId/model/cost come off the
  // event rather than the session registry below: agent-client's settleTurn
  // already resolves them at the boundary (real harness + resolved model +
  // this turn's own cost delta), and a group-chat thread has no selection
  // mirror for the registry to answer from. sessionKey and quota ride along
  // for the store to decode — the turn's `agent` and its per-model rows (see
  // recordChatUsageTurn). Fire-and-forget like everything else here: an event
  // observer must not hold up the emit, and a failed write costs one
  // unrecorded turn, never the turn itself.
  if (event.usage) {
    void recordChatUsageTurn({
      sessionId,
      sessionKey,
      adapterId: event.adapterId,
      model: event.model,
      usage: event.usage,
      cost: event.cost,
      quota: event.quota,
    }).catch((error) => {
      console.error('Failed to record chat usage for session', sessionId, error)
    })
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

/**
 * Resume the session a key belongs to, whatever registry owns it.
 *
 * Held here rather than imported so the cycle described at `openSessionForKey`
 * stays open; `server/startup.ts` fills it in. Unset means the wake covers only
 * sessions already in memory — which is what it covered before this existed, so
 * a boot that has not reached startup yet degrades rather than throws.
 */
type SessionOpener = (sessionKey: string) => Promise<unknown>

let sessionOpener: SessionOpener | undefined

export function registerSessionOpener(opener: SessionOpener): void {
  sessionOpener = opener
}

/**
 * What to do when a session's harness reports a compaction — same seam and
 * same cycle-avoidance reason as SessionOpener above: the handler lives in
 * stream.ts (which imports this module for the client itself), so
 * `server/startup.ts` fills it in. Unset means compactions are recorded and
 * rendered but trigger no host reaction — the pre-startup degradation, not an
 * error.
 */
type CompactionHandler = (sessionId: string, compaction: CompactionState) => Promise<unknown>

let compactionHandler: CompactionHandler | undefined

export function registerCompactionHandler(handler: CompactionHandler): void {
  compactionHandler = handler
}

// Bridge-side forensics: claude-agent-acp appends a per-process decision log
// (session/replay phases, subagent routing, steering) to this directory when
// the variable is set — spawned bridges inherit process.env. Under the app's
// own data dir (gitignored, survives dev-server restarts), and `??=` so an
// operator-set path is never overridden. Costs one small append-only file per
// bridge process; without it a wire-level question ("did the harness announce
// this subagent on replay?") has no answer after the fact.
process.env.CLAUDE_AGENT_LOGS ??= join(process.cwd(), 'data', 'claude-acp-logs')

// The Claude Agent SDK gates its todo/task tools (TodoWrite, TaskCreate/Update/
// List) behind an opt-in env flag — default OFF — so without this the model is
// never handed a tool to track a plan, and claude-agent-acp's TodoWrite→`plan`
// translation has nothing to translate: the Chat Turn plan block stays empty
// and the agent has no task tools at all. Spawned bridges inherit process.env,
// and `??=` leaves an operator override in place. Harmless to non-Claude
// adapters, which ignore an env var they don't read.
process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS ??= '1'

export const agentClient = createAgentClient({
  // Sleep Mode's gate: while the instance is asleep no queue is drained to
  // any agent — see (mcp)/_server/sleep-mode for why the flag is a
  // per-instance marker file. The hook itself is host-agnostic; the policy
  // stays here.
  shouldHoldDelivery: isSleepMode,
  tools: opencroftLocalTools,
  loadMcpServers: readMcpServersForAgent,
  // Durable copy of the queue. Written behind the in-memory one, and read back
  // to restore a session that is opening — plus, since the delivery gate
  // learned to reach sessions this process does not have, enumerated on wake to
  // decide which ones to open. See QueueStore, whose doc carries the same
  // exception.
  queueStore,
  // How a key with a waiting queue gets a session again. Registered at server
  // startup rather than imported: stream.ts already imports this module for the
  // client itself, so reaching back for the opener statically would close a
  // cycle. Same seam, and the same reason, as the session-wake and
  // standing-context resolvers that module registers.
  openSessionForKey: async (sessionKey: string) => {
    await sessionOpener?.(sessionKey)
  },
  loadPresence,
  // The bytes behind the images a delivered message names. Scoped to the
  // session key the engine hands over: a message's text is editable, so an id
  // from another conversation has to resolve to nothing rather than to a
  // picture. A session with no key resolves nothing at all, which is the honest
  // answer — there is no conversation to have stored one under.
  loadAttachments: ({ sessionKey, ids }) => (sessionKey ? loadAttachments(sessionKey, ids) : Promise.resolve([])),
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
  onEvent: (sessionId, event, sessionKey) => {
    persistSessionEvent(event, sessionKey)
    persistUsageOnTurnEnd(sessionId, event, sessionKey)
  },
  // Live compaction transitions (never replay — the engine gates that). The
  // registered handler re-delivers the session's standing context once a
  // compaction completes; see stream.ts's restoreAfterCompaction.
  onCompaction: (sessionId, compaction) => {
    void compactionHandler?.(sessionId, compaction).catch((error) => {
      console.error('Compaction handler failed for session', sessionId, error)
    })
  },
  // A task this host runs (see (background-tasks)) is stopped by the registry
  // that runs it. The engine hands a stop pressed on one here instead of to the
  // harness, which never heard of the task.
  ...stopHostTaskOption(({ asyncTaskId }) => backgroundTasks.requestStop(asyncTaskId)),
})

// Waking is the flag's only transition with work attached: every idle
// session's held queue drains, in order, the moment sleep turns off — from
// the toggle, or from an out-of-band marker removal the next time anything
// reads the flag. Going to sleep needs nothing: the next drain attempt
// consults the gate by itself.
subscribeSleepMode((enabled) => {
  if (!enabled) {
    agentClient.resumeDelivery()
  }
})
