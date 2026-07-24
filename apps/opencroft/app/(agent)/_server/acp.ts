import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createServerFn } from '@tanstack/react-start'
import { supportsMidTurnInput } from 'agent-client'
import type { EventsWindow } from 'agent-client/pagination'
import type { AgentSelection } from 'agent-client/types'

import {
  deletePersistedConfigOptions,
  deletePersistedSession,
  readPersistedConfigOptions,
  readPersistedSession,
  writePersistedConfigOption,
  writePersistedSession,
} from '@/app/(agent)/_server/acp-session-store'
import { agentClient } from '@/app/(agent)/_server/agent-client-instance'
import { slug } from '@/app/(server)/_server/types'
import { getSpacesRegistry } from '@/app/(space)/_server/store'
import { secrets } from '@/server/secrets'

interface AgentNodeData {
  name?: string
  providerId?: string
  adapterId?: string
  model?: string
  apiKeySecret?: string
  defaultModeId?: string
  baseUrl?: string
  systemPrompt?: string
  reasoningEffort?: string
  temperature?: number
  containerName?: string
}

async function findNodeData<T>(nodeId: string): Promise<T | null> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  for (const summary of registry.list()) {
    const space = registry.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    const node = (space.graph.nodes as { id?: string; data?: T }[]).find((n) => n.id === nodeId)
    if (node) {
      return node.data ?? null
    }
  }
  return null
}

async function resolveSecret(key: string): Promise<string> {
  if (!key) {
    return ''
  }
  return (await secrets.resolve(key)) ?? ''
}

interface TabSession {
  id: string
  // Whether this tab's agent can fork its history (native harness only).
  canFork: boolean
  // Whether this tab's agent accepts mid-turn prompts as live-turn input
  // (adapter-declared; see agent-client's supportsMidTurnInput).
  canSteer: boolean
}

// ACP sessions live only in agentClient's memory, so they don't survive a dev
// server restart. Map each opencroft chat tab to its live ACP session id and
// re-create lazily — this keeps session creation idempotent per tab (no loops)
// and self-heals after a restart, without persisting fragile ids to the client.
const globalRef = globalThis as typeof globalThis & {
  __acpTabSessions?: Map<string, TabSession>
  __acpEnsureInFlight?: Map<
    string,
    Promise<{ sessionId: string; canFork: boolean; canSteer: boolean; created: boolean }>
  >
}
if (!globalRef.__acpTabSessions) {
  globalRef.__acpTabSessions = new Map()
}
if (!globalRef.__acpEnsureInFlight) {
  globalRef.__acpEnsureInFlight = new Map()
}
const tabSessions = globalRef.__acpTabSessions
// Coalesce concurrent ensureLocalSession calls for the same tab. The inspector
// fires several on mount/focus; without this they race into duplicate, competing
// load/create sessions for a single tab.
const ensureInFlight = globalRef.__acpEnsureInFlight

// Build the agent's selection in memory from its node data + Secrets Store key
// (no on-disk profile store), and open (or reuse) the ACP session for this tab.
export const ensureLocalSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { agentNodeId: string; jobNodeId: string; tabKey: string }) => data)
  .handler(async ({ data }): Promise<{ sessionId: string; canFork: boolean; canSteer: boolean; created: boolean }> => {
    const pending = ensureInFlight.get(data.tabKey)
    if (pending) {
      return pending
    }
    const run = openLocalSession(data)
    ensureInFlight.set(data.tabKey, run)
    try {
      return await run
    } finally {
      ensureInFlight.delete(data.tabKey)
    }
  })

// `created` is the one authoritative signal for whether a brand-new ACP
// session was just spun up (agentClient.createSession) vs. an existing one
// reused (in-memory tab-cache hit or a cold-start session/load resume).
// Callers key session-scoped envelope content (task context, instructions) off
// this instead of inferring it themselves — see the message-envelope module.
async function openLocalSession(data: {
  agentNodeId: string
  jobNodeId: string
  tabKey: string
}): Promise<{ sessionId: string; canFork: boolean; canSteer: boolean; created: boolean }> {
  const known = tabSessions.get(data.tabKey)
  if (known && agentClient.listSessions().some((s) => s.id === known.id)) {
    // `?? false` covers entries recorded before canSteer existed (the map
    // survives dev hot-reloads).
    return { sessionId: known.id, canFork: known.canFork, canSteer: known.canSteer ?? false, created: false }
  }
  const agent = await findNodeData<AgentNodeData>(data.agentNodeId)
  if (!agent) {
    throw new Error('Agent node not found')
  }
  // Each agent gets a persistent workspace next to the DB in the data volume,
  // keyed by slug: <cwd>/data/agent-workspace/<agent-slug>.
  const workspaceSlug = slug(agent.name ?? '') || data.agentNodeId
  const adapterId = agent.adapterId ?? 'claude'
  const containerName = agent.containerName || undefined
  const selection: AgentSelection = {
    providerId: agent.providerId ?? '',
    adapterId,
    model: agent.model ?? '',
    // The API token / base URL fall back to the OPENCLAW_GATEWAY_* env vars when
    // the node leaves them unset, so a deployment can supply them globally.
    apiKey: (await resolveSecret(agent.apiKeySecret ?? '')) || process.env.OPENCLAW_GATEWAY_TOKEN || '',
    // In a container the harness gets its own /agents/<slug> workdir (created in
    // the container on spawn); on the host it's a persistent dir in the data volume.
    cwd: containerName ? `/agents/${workspaceSlug}` : join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    containerName,
    baseUrl: agent.baseUrl || process.env.OPENCLAW_GATEWAY_URL,
    systemPrompt: agent.systemPrompt,
    reasoningEffort: agent.reasoningEffort,
    temperature: agent.temperature,
    // The chat tab key is already a stable session key
    // (agent:<agent-slug>:<job>:<unique>); forward it so an ACP bridge can bind
    // this session to a stable gateway session/agent instead of an ephemeral
    // acp-bridge:<uuid> session.
    sessionKey: data.tabKey,
  }
  // Host spawn cwd must exist or spawn fails with ENOENT; the container path is
  // created inside the container when the harness is exec'd.
  if (!containerName) {
    await mkdir(selection.cwd, { recursive: true })
  }
  // Whether this agent takes mid-turn prompts as live-turn input — decided by
  // the adapter (single source: agent-client's table), surfaced to the client
  // so it can pick the right permission-rejection flow.
  const canSteer = supportsMidTurnInput(selection)

  // Cold start (the in-memory tab→session map is lost on a server restart): if
  // this tab's ACP session id was persisted, resume it by replaying history
  // (session/load) so the conversation comes back. We only persist a session
  // after its first prompt (so a transcript exists), but still fall through to a
  // fresh session if the agent can't load it.
  const persistedId = await readPersistedSession(data.tabKey)
  if (persistedId) {
    const resumed = await agentClient.loadSession(persistedId, selection).catch(() => null)
    if (resumed) {
      const canFork = resumed.canFork ?? false
      tabSessions.set(data.tabKey, { id: resumed.id, canFork, canSteer })
      // Re-apply any per-session config overrides (e.g. reasoning effort) the
      // user set before this tab's in-memory session was lost — loadSession
      // only reflects the agent's own resumed state, which has no way to know
      // about a change that was never written back to the agent's profile.
      const overrides = await readPersistedConfigOptions(data.tabKey)
      for (const [configId, value] of Object.entries(overrides)) {
        await agentClient.setConfigOption(resumed.id, configId, value).catch(() => {})
      }
      return { sessionId: resumed.id, canFork, canSteer, created: false }
    }
  }

  const meta = await agentClient.createSession(selection, agent.defaultModeId)
  // Forking rewinds an agent's own message history, which only the in-process
  // (native) harness owns — external ACP agents can't truncate it.
  const canFork = meta.canFork ?? false
  tabSessions.set(data.tabKey, { id: meta.id, canFork, canSteer })
  return { sessionId: meta.id, canFork, canSteer, created: true }
}

// `front` queues the message ahead of anything already held for the session
// when a turn is running (e.g. corrective guidance after a rejected permission).
export const promptLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; text: string; front?: boolean }) => data)
  .handler(async ({ data }): Promise<void> => {
    await agentClient.prompt(data.sessionId, data.text, { front: data.front })
    // Persist the tab→session pointer now that the session has real history, so a
    // later restart can resume it via session/load. We never persist — and so
    // never try to load — an empty, never-prompted session.
    for (const [tabKey, entry] of tabSessions) {
      if (entry.id === data.sessionId) {
        await writePersistedSession(tabKey, data.sessionId)
        break
      }
    }
  })

// Resolve the live ACP session a Send Message node should target for a base
// session key (`agent:<agent-slug>:<job-slug>`). The chat UI opens sessions with
// a unique suffix (`...:<uniq>`), so a node-owned session created under the bare
// base key is distinct from any tab the user has open. We bridge the two:
//   1. Prefer the node's own remembered session (exact base key) once it exists,
//      so repeated sends reuse the same session instead of spawning duplicates.
//   2. Otherwise adopt the user's most recently created live chat for this
//      agent+job (a suffixed variant), so the message lands in a chat they can see.
//   3. Return null when nothing live exists yet — the caller then creates a fresh
//      session (and remembers it via promptLocal's persisted pointer).
export const findTargetSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { baseKey: string }) => data)
  .handler(async ({ data }): Promise<{ sessionId: string } | null> => {
    const createdById = new Map(agentClient.listSessions().map((s) => [s.id, s.createdAt]))
    // 1. The node's own remembered session, if still live.
    const exact = tabSessions.get(data.baseKey)
    if (exact && createdById.has(exact.id)) {
      return { sessionId: exact.id }
    }
    // 2. The most recently created live chat tab for this agent+job.
    const prefix = `${data.baseKey}:`
    let best: { id: string; createdAt: number } | null = null
    for (const [tabKey, entry] of tabSessions) {
      if (!tabKey.startsWith(prefix)) {
        continue
      }
      const createdAt = createdById.get(entry.id)
      if (createdAt === undefined) {
        continue // stale pointer to a session that's no longer live
      }
      if (!best || createdAt > best.createdAt) {
        best = { id: entry.id, createdAt }
      }
    }
    return best ? { sessionId: best.id } : null
  })

// Drop a message from the session's server-side queue before it's delivered.
// Clients observe the result via the 'queue' snapshot event on the stream.
export const removeQueuedLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    agentClient.removeQueued(data.sessionId, data.id)
  })

export const setLocalMode = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; modeId: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    await agentClient.setMode(data.sessionId, data.modeId)
  })

// Change one of the session's agent-advertised config options (model/effort/
// mode/…). Applies to this session only — never written back into the
// profile the session was started from.
export const setLocalConfigOption = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; configId: string; value: string | boolean }) => data)
  .handler(async ({ data }): Promise<void> => {
    await agentClient.setConfigOption(data.sessionId, data.configId, data.value)
    // Also persist it per-tab so a later cold-start resume (openLocalSession's
    // session/load path) can replay it — see the comment there. Assumes the
    // sessionId is already in tabSessions (true for every current caller, all
    // of which go through a tab); an override set through any future path
    // that bypasses the tab map would silently skip persistence.
    for (const [tabKey, entry] of tabSessions) {
      if (entry.id === data.sessionId) {
        await writePersistedConfigOption(tabKey, data.configId, data.value)
        break
      }
    }
  })

export const cancelLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }): Promise<void> => {
    await agentClient.cancel(sessionId)
  })

export const hasActiveTurn = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }): Promise<boolean> => agentClient.hasActiveTurn(sessionId))

export const forgetLocalSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((tabKey: string) => tabKey)
  .handler(async ({ data: tabKey }): Promise<void> => {
    const entry = tabSessions.get(tabKey)
    if (entry) {
      await agentClient.deleteSession(entry.id)
      tabSessions.delete(tabKey)
    }
    // Drop the durable pointer too, so a later restart doesn't resurrect it.
    await deletePersistedSession(tabKey)
    await deletePersistedConfigOptions(tabKey)
  })

// Branch the tab's session into a new one rewound to a user turn (0-based;
// drops that turn and everything after). Re-point the tab at the fork so a
// remount resumes the branch instead of re-creating the original.
export const forkLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { tabKey: string; sessionId: string; dropFromTurn: number }) => data)
  .handler(async ({ data }): Promise<{ sessionId: string } | null> => {
    const meta = await agentClient.forkSession(data.sessionId, data.dropFromTurn)
    if (!meta) {
      return null
    }
    // The fork keeps the same agent, so steering capability carries over.
    tabSessions.set(data.tabKey, {
      id: meta.id,
      canFork: true,
      canSteer: tabSessions.get(data.tabKey)?.canSteer ?? false,
    })
    // Re-point the durable pointer at the fork so a restart resumes the branch.
    await writePersistedSession(data.tabKey, meta.id)
    return { sessionId: meta.id }
  })

// Tab keys of chat sessions currently blocked on an unresolved permission
// request, tab keys with a turn actively running, and tab keys with a live
// agent process at all (alive is a superset of the other two — see
// aliveSessionKeys) — the sidebar polls this once to set each chat's
// process-visibility indicator: warning (pending),
// primary (active), success (alive but neither), or none (not in `alive`).
export const listSessionActivity = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<{ pending: string[]; active: string[]; alive: string[] }> => ({
    pending: agentClient.pendingPermissionSessionKeys(),
    active: agentClient.activeSessionKeys(),
    alive: agentClient.aliveSessionKeys(),
  }),
)

// Stop a session's agent process without closing the chat: ends the ACP
// session (gracefully, or kills the underlying subprocess if nothing else
// shares it — see agentClient.deleteSession) but, unlike forgetLocalSession,
// deliberately keeps the persisted tabKey->sessionId pointer and config
// overrides. The next message to this tab falls through to
// openLocalSession's cold-start session/load path and resumes the same
// session — the chat and its history are untouched.
export const stopProcessLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((tabKey: string) => tabKey)
  .handler(async ({ data: tabKey }): Promise<void> => {
    const entry = tabSessions.get(tabKey)
    if (entry) {
      await agentClient.deleteSession(entry.id)
      tabSessions.delete(tabKey)
    }
  })

// How many turns a single "load older" scroll fetches — independent of
// acp.stream.ts's INITIAL_HISTORY_TURNS (the two don't need to match, though
// keeping them equal makes each older page roughly one screenful).
const HISTORY_PAGE_TURNS = 5

// The "older messages" half of the tail-first + scroll-up pagination pattern
// is a plain request/response fetch against the
// already-replayed, already in-memory event log — no protocol round-trip, no
// SSE. `beforeIndex` is a previous window's `startIndex` (the stream's
// history_end payload for the first call, or an earlier page's for the next).
export const getSessionHistoryPageLocal = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((data: { sessionId: string; beforeIndex: number }) => data)
  .handler(
    async ({ data }): Promise<EventsWindow | null> =>
      agentClient.getEventsWindow(data.sessionId, { beforeIndex: data.beforeIndex, turns: HISTORY_PAGE_TURNS }),
  )

export const respondLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { type: 'permission' | 'ask'; requestId: string; optionId?: string; answer?: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    if (data.type === 'permission') {
      agentClient.resolvePermission(data.requestId, data.optionId)
      return
    }
    agentClient.resolveElicitation(data.requestId, data.answer)
  })
