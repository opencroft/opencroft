import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { prisma } from '@opencroft/db'
import { createServerFn } from '@tanstack/react-start'
import type { AgentSelection } from 'agent-client/types'
import { agentClient } from '@/app/(agent)/_server/agent-client-instance'
import { slug } from '@/app/(server)/_server/types'
import { getSpacesRegistry } from '@/app/(space)/_server/store'
import { decrypt } from '@/server/crypto'

interface AgentNodeData {
  name?: string
  backend?: 'openclaw' | 'local'
  providerId?: string
  adapterId?: string
  model?: string
  apiKeySecret?: string
  defaultModeId?: string
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
  const row = await prisma.secret.findFirst({ where: { key } })
  return row ? decrypt(row.value) : ''
}

// ACP sessions live only in agentClient's memory, so they don't survive a dev
// server restart. Map each opencroft chat tab to its live ACP session id and
// re-create lazily — this keeps session creation idempotent per tab (no loops)
// and self-heals after a restart, without persisting fragile ids to the client.
const globalRef = globalThis as typeof globalThis & {
  __acpTabSessions?: Map<string, string>
}
if (!globalRef.__acpTabSessions) {
  globalRef.__acpTabSessions = new Map()
}
const tabSessions = globalRef.__acpTabSessions

// Build the agent's selection in memory from its node data + Secrets Store key
// (no on-disk profile store), and open (or reuse) the ACP session for this tab.
export const ensureLocalSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { agentNodeId: string; jobNodeId: string; tabKey: string }) => data)
  .handler(async ({ data }): Promise<{ sessionId: string }> => {
    const known = tabSessions.get(data.tabKey)
    if (known && agentClient.listSessions().some((s) => s.id === known)) {
      return { sessionId: known }
    }
    const agent = await findNodeData<AgentNodeData>(data.agentNodeId)
    if (!agent) {
      throw new Error('Agent node not found')
    }
    // Each agent gets a persistent workspace next to the DB in the data volume,
    // keyed by slug: <cwd>/data/agent-workspace/<agent-slug>.
    const workspaceSlug = slug(agent.name ?? '') || data.agentNodeId
    const selection: AgentSelection = {
      providerId: agent.providerId ?? '',
      adapterId: agent.adapterId ?? 'claude',
      model: agent.model ?? '',
      apiKey: await resolveSecret(agent.apiKeySecret ?? ''),
      cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    }
    // Spawn cwd must exist or spawn fails with ENOENT.
    await mkdir(selection.cwd, { recursive: true })
    const meta = await agentClient.createSession(selection, agent.defaultModeId)
    tabSessions.set(data.tabKey, meta.id)
    return { sessionId: meta.id }
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
    const id = tabSessions.get(tabKey)
    if (id) {
      agentClient.deleteSession(id)
      tabSessions.delete(tabKey)
    }
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
