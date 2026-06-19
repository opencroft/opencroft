import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createServerFn } from '@tanstack/react-start'
import type { AgentSelection } from 'agent-client/types'

import {
  deletePersistedSession,
  readPersistedSession,
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
}

// ACP sessions live only in agentClient's memory, so they don't survive a dev
// server restart. Map each opencroft chat tab to its live ACP session id and
// re-create lazily — this keeps session creation idempotent per tab (no loops)
// and self-heals after a restart, without persisting fragile ids to the client.
const globalRef = globalThis as typeof globalThis & {
  __acpTabSessions?: Map<string, TabSession>
  __acpEnsureInFlight?: Map<string, Promise<{ sessionId: string; canFork: boolean }>>
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
  .handler(async ({ data }): Promise<{ sessionId: string; canFork: boolean }> => {
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

async function openLocalSession(data: {
  agentNodeId: string
  jobNodeId: string
  tabKey: string
}): Promise<{ sessionId: string; canFork: boolean }> {
  const known = tabSessions.get(data.tabKey)
  if (known && agentClient.listSessions().some((s) => s.id === known.id)) {
    return { sessionId: known.id, canFork: known.canFork }
  }
  const agent = await findNodeData<AgentNodeData>(data.agentNodeId)
  if (!agent) {
    throw new Error('Agent node not found')
  }
  // Each agent gets a persistent workspace next to the DB in the data volume,
  // keyed by slug: <cwd>/data/agent-workspace/<agent-slug>.
  const workspaceSlug = slug(agent.name ?? '') || data.agentNodeId
  const adapterId = agent.adapterId ?? 'claude'
  const selection: AgentSelection = {
    providerId: agent.providerId ?? '',
    adapterId,
    model: agent.model ?? '',
    // The API token / base URL fall back to the OPENCLAW_GATEWAY_* env vars when
    // the node leaves them unset, so a deployment can supply them globally.
    apiKey: (await resolveSecret(agent.apiKeySecret ?? '')) || process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
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
  // Spawn cwd must exist or spawn fails with ENOENT.
  await mkdir(selection.cwd, { recursive: true })

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
      tabSessions.set(data.tabKey, { id: resumed.id, canFork })
      return { sessionId: resumed.id, canFork }
    }
  }

  const meta = await agentClient.createSession(selection, agent.defaultModeId)
  // Forking rewinds an agent's own message history, which only the in-process
  // (native) harness owns — external ACP agents can't truncate it.
  const canFork = meta.canFork ?? false
  tabSessions.set(data.tabKey, { id: meta.id, canFork })
  return { sessionId: meta.id, canFork }
}

export const promptLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; text: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    await agentClient.prompt(data.sessionId, data.text)
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

export const setLocalMode = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; modeId: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    await agentClient.setMode(data.sessionId, data.modeId)
  })

export const cancelLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }): Promise<void> => {
    await agentClient.cancel(sessionId)
  })

export const forgetLocalSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((tabKey: string) => tabKey)
  .handler(async ({ data: tabKey }): Promise<void> => {
    const entry = tabSessions.get(tabKey)
    if (entry) {
      agentClient.deleteSession(entry.id)
      tabSessions.delete(tabKey)
    }
    // Drop the durable pointer too, so a later restart doesn't resurrect it.
    await deletePersistedSession(tabKey)
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
    tabSessions.set(data.tabKey, { id: meta.id, canFork: true })
    // Re-point the durable pointer at the fork so a restart resumes the branch.
    await writePersistedSession(data.tabKey, meta.id)
    return { sessionId: meta.id }
  })

export const respondLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { type: 'permission' | 'ask'; requestId: string; optionId?: string; answer?: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    if (data.type === 'permission') {
      agentClient.resolvePermission(data.requestId, data.optionId)
      return
    }
    agentClient.resolveElicitation(data.requestId, data.answer)
  })
