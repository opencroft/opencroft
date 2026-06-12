import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createServerFn } from '@tanstack/react-start'
import type { AgentSelection } from 'agent-client/types'
import { agentClient } from '@/app/(agent)/_server/agent-client-instance'
import { slug } from '@/app/(server)/_server/types'
import { getSpacesRegistry } from '@/app/(space)/_server/store'
import { secrets } from '@/server/secrets'

interface AgentNodeData {
  name?: string
  backend?: 'openclaw' | 'local'
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
}
if (!globalRef.__acpTabSessions) {
  globalRef.__acpTabSessions = new Map()
}
const tabSessions = globalRef.__acpTabSessions

// Build the agent's selection in memory from its node data + Secrets Store key
// (no on-disk profile store), and open (or reuse) the ACP session for this tab.
export const ensureLocalSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { agentNodeId: string; jobNodeId: string; tabKey: string }) => data)
  .handler(async ({ data }): Promise<{ sessionId: string; canFork: boolean }> => {
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
      apiKey: await resolveSecret(agent.apiKeySecret ?? ''),
      cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
      baseUrl: agent.baseUrl,
      systemPrompt: agent.systemPrompt,
      reasoningEffort: agent.reasoningEffort,
      temperature: agent.temperature,
    }
    // Spawn cwd must exist or spawn fails with ENOENT.
    await mkdir(selection.cwd, { recursive: true })
    const meta = await agentClient.createSession(selection, agent.defaultModeId)
    // Forking rewinds an agent's own message history, which only the in-process
    // (native) harness owns — external ACP agents can't truncate it.
    const canFork = meta.canFork ?? false
    tabSessions.set(data.tabKey, { id: meta.id, canFork })
    return { sessionId: meta.id, canFork }
  })

export const promptLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; text: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    await agentClient.prompt(data.sessionId, data.text)
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
