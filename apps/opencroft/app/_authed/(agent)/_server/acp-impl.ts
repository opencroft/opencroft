// Plain (non-`createServerFn`) session machinery, plus the tab->session state
// every caller shares.
//
// This lives apart from acp.ts on purpose, and the separation is load-bearing
// for the CLIENT BUILD, not just for tidiness. acp.ts is imported directly by
// browser components (app-shell.tsx, ai-panel.tsx, the chat hooks), so it sits
// in the client graph on every page. It survives there only because every one
// of its exports is a `createServerFn`: the client build replaces each with an
// RPC stub, which leaves acp.ts's own top-level imports unused and lets them —
// agentClient, and `esbuild`/`ssh2`/`@tailwindcss/node` in its dependency tail —
// be dropped from the browser bundle.
//
// A plain exported function has no stub, so adding one to acp.ts keeps that
// whole import tail alive and ships bare Node specifiers to the browser, which
// fails to link the module graph and leaves the canvas stuck loading. Server-side
// callers that must avoid nesting one `createServerFn` inside another's handler
// (see deliverToSendMessageNode) therefore import from HERE, and acp.ts keeps
// its all-`createServerFn` export list intact.
//
// The rule this file exists to hold: nothing under `_components`, `_lib`,
// `_canvas`, `_shell` — anything reachable from `'use client'` — may import this
// module. Making an import lazy or SSR-guarding it does not help; only
// reachability matters.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { supportsMidTurnInput } from 'agent-client'
import type { AgentSelection } from 'agent-client/types'

import {
  readPersistedConfigOptions,
  readPersistedSession,
  writePersistedSession,
} from '@/app/_authed/(agent)/_server/acp-session-store'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { slug } from '@/app/_authed/(server)/_server/types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
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

export interface OpenedSession {
  sessionId: string
  canFork: boolean
  canSteer: boolean
  created: boolean
}

export interface TabSession {
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
  __acpEnsureInFlight?: Map<string, Promise<OpenedSession>>
}
if (!globalRef.__acpTabSessions) {
  globalRef.__acpTabSessions = new Map()
}
if (!globalRef.__acpEnsureInFlight) {
  globalRef.__acpEnsureInFlight = new Map()
}
export const tabSessions = globalRef.__acpTabSessions
// Coalesce concurrent ensureLocalSession calls for the same tab. The inspector
// fires several on mount/focus; without this they race into duplicate, competing
// load/create sessions for a single tab.
const ensureInFlight = globalRef.__acpEnsureInFlight

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

// Build the agent's selection in memory from its node data + Secrets Store key
// (no on-disk profile store), and open (or reuse) the ACP session for this tab.
export async function ensureLocalSessionImpl(data: {
  agentNodeId: string
  jobNodeId: string
  tabKey: string
}): Promise<OpenedSession> {
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
}

// `created` is the one authoritative signal for whether a brand-new ACP
// session was just spun up (agentClient.createSession) vs. an existing one
// reused (in-memory tab-cache hit or a cold-start session/load resume).
// Callers key session-scoped envelope content (task context, instructions) off
// this instead of inferring it themselves — see the message-envelope module.
async function openLocalSession(data: {
  agentNodeId: string
  jobNodeId: string
  tabKey: string
}): Promise<OpenedSession> {
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
    // Same slug used for the workspace dir — lets loadMcpServers (mcp-store.ts)
    // surface this agent's own MCP Connection node(s) without a global entry.
    mcpIdentity: workspaceSlug,
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
// `flush` instead delivers everything held together with this message as one
// turn — used after interrupting a turn, so the agent sees the whole picture.
export async function promptLocalImpl(data: {
  sessionId: string
  text: string
  front?: boolean
  flush?: boolean
}): Promise<void> {
  await agentClient.prompt(data.sessionId, data.text, { front: data.front, flush: data.flush })
  // Persist the tab→session pointer now that the session has real history, so a
  // later restart can resume it via session/load. We never persist — and so
  // never try to load — an empty, never-prompted session.
  for (const [tabKey, entry] of tabSessions) {
    if (entry.id === data.sessionId) {
      await writePersistedSession(tabKey, data.sessionId)
      break
    }
  }
}

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
export function findTargetSessionImpl(data: { baseKey: string }): { sessionId: string } | null {
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
}

export async function cancelLocalImpl(sessionId: string): Promise<void> {
  await agentClient.cancel(sessionId)
}

export function hasActiveTurnImpl(sessionId: string): boolean {
  return agentClient.hasActiveTurn(sessionId)
}
