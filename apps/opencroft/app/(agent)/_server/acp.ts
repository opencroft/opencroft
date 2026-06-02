import { mkdir } from 'node:fs/promises'

import { prisma } from '@opencroft/db'
import { createServerFn } from '@tanstack/react-start'
import type { AgentProfile } from 'agent-client/profiles'
import { readProfiles, writeProfiles } from 'agent-client/profiles-store'
import { agentClient } from '@/app/(agent)/_server/agent-client-instance'
import { getSpacesRegistry } from '@/app/(space)/_server/store'
import { decrypt } from '@/server/crypto'

interface AgentNodeData {
  name?: string
  backend?: 'openclaw' | 'local'
  providerId?: string
  adapterId?: string
  model?: string
  apiKeySecret?: string
  cwd?: string
  defaultModeId?: string
}

interface JobNodeData {
  workingDirectory?: string
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

function profileId(agentNodeId: string): string {
  return `agent-${agentNodeId}`
}

async function upsertProfile(profile: AgentProfile): Promise<void> {
  const file = await readProfiles()
  const profiles = file.profiles.filter((p) => p.id !== profile.id)
  profiles.push(profile)
  await writeProfiles({ profiles, activeProfileId: file.activeProfileId })
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

// Derive an agent-client profile from the Agent node's data, persist it, and
// open (or reuse) the ACP session bound to this chat tab. Returns its id.
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
    const job = await findNodeData<JobNodeData>(data.jobNodeId)
    const id = profileId(data.agentNodeId)
    const profile: AgentProfile = {
      id,
      name: agent.name?.trim() || id,
      selection: {
        providerId: agent.providerId ?? '',
        adapterId: agent.adapterId ?? 'claude',
        model: agent.model ?? '',
        apiKey: await resolveSecret(agent.apiKeySecret ?? ''),
        cwd: agent.cwd?.trim() || job?.workingDirectory?.trim() || '/app',
      },
      defaultModeId: agent.defaultModeId,
    }
    await upsertProfile(profile)
    // The harness is spawned with cwd = the profile's working directory; create
    // it up front so spawn doesn't fail with ENOENT on a missing path.
    await mkdir(profile.selection.cwd, { recursive: true })
    const meta = await agentClient.createSession(id)
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
