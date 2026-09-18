// Opt-in background reaper: periodically unloads the
// process of any live session whose owning agent has opted in (agent-card
// toggle, default off) and has been idle longer than that agent's threshold.
// Builds directly on stopLocalSessionProcessImpl (the same primitive the
// send-message node's `unload` action and the chat sidebar's "Stop process"
// control both already use) -- unloading here is exactly as safe/transparent
// as either of those, just triggered by elapsed idle time instead of a click.

import { stopLocalSessionProcessImpl } from '@/app/_authed/(agent)/_server/acp-impl'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import {
  agentAutoUnloadIdleEnabled,
  agentAutoUnloadIdleMinutes,
  isAgentNode,
} from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { deriveSessionStatus, type SessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import { partsOfSessionKey } from '@/app/_authed/(group-chats)/_shared/session-key'
import { slug } from '@/app/_authed/(server)/_server/types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

const TICK_MS = 60_000
const DEFAULT_IDLE_MINUTES = 45

export interface AgentIdleConfig {
  enabled: boolean
  thresholdMs: number
}

export interface ReapCandidateSession {
  sessionKey: string
  lastActivityAt: number
}

// The owning agent's slug from a group-chat thread key,
// `group-chat.<chat>.<agent>.<thread>` (both stored spellings).
// Null for anything else — an unrecognised key is skipped, never guessed at.
// A group-chat key's agent segment was frozen at thread creation, so an agent
// renamed since stops matching its node and its sessions are left alone: the
// same fail-safe direction every other miss in this module takes.
export function ownerAgentSlug(sessionKey: string): string | null {
  return partsOfSessionKey(sessionKey)?.agentSlug ?? null
}

// Pure: which sessions are due for unload, given an already-resolved status
// per session and idle config per agent slug. No I/O, so this is the seam
// unit tests drive directly instead of waiting on the module's own timer.
export function selectDueSessions(
  sessions: ReapCandidateSession[],
  statuses: Map<string, SessionStatus>,
  configFor: (agentSlug: string) => AgentIdleConfig | null,
  now: number,
): string[] {
  const due: string[] = []
  for (const session of sessions) {
    if (statuses.get(session.sessionKey) !== 'idle') {
      continue
    }
    const agentSlug = ownerAgentSlug(session.sessionKey)
    if (!agentSlug) {
      continue
    }
    const config = configFor(agentSlug)
    if (!config?.enabled) {
      continue
    }
    if (now - session.lastActivityAt >= config.thresholdMs) {
      due.push(session.sessionKey)
    }
  }
  return due
}

function currentStatuses(sessionKeys: string[]): Map<string, SessionStatus> {
  const keys = {
    pending: new Set(agentClient.pendingPermissionSessionKeys()),
    active: new Set(agentClient.activeSessionKeys()),
    background: new Set(agentClient.backgroundWorkSessionKeys()),
    alive: new Set(agentClient.aliveSessionKeys()),
  }
  return new Map(sessionKeys.map((key) => [key, deriveSessionStatus(key, keys)]))
}

// Global (all spaces) agent-slug -> idle-reaper config, the same
// getSpacesRegistry/getBySlug walk every other cross-space scanner in this
// codebase uses (see docker-ps-poller.ts's collectDockerNodeIds). Built fresh
// each tick rather than cached: an agent's toggle/threshold can change between
// ticks, and this is a once-a-minute scan, not a hot path.
async function resolveAgentConfigs(agentSlugs: Set<string>): Promise<Map<string, AgentIdleConfig>> {
  const configs = new Map<string, AgentIdleConfig>()
  if (agentSlugs.size === 0) {
    return configs
  }
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  for (const summary of registry.list()) {
    const space = registry.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    const spaceNodes = [...space.graphs.values()].flatMap((g) => g.graph.nodes)
    for (const node of spaceNodes as { type?: string; data?: Record<string, unknown> }[]) {
      if (!isAgentNode(node)) {
        continue
      }
      const nameValue = node.data?.['name']
      const nodeSlug = slug(typeof nameValue === 'string' ? nameValue : '')
      if (!nodeSlug || !agentSlugs.has(nodeSlug)) {
        continue
      }
      const minutes = agentAutoUnloadIdleMinutes(node) ?? DEFAULT_IDLE_MINUTES
      configs.set(nodeSlug, { enabled: agentAutoUnloadIdleEnabled(node), thresholdMs: minutes * 60_000 })
    }
  }
  return configs
}

const globalForReaper = globalThis as unknown as {
  __IDLE_SESSION_REAPER__?: { timer: NodeJS.Timeout }
  __idleSessionReapInFlight?: Set<string>
}
if (!globalForReaper.__idleSessionReapInFlight) {
  globalForReaper.__idleSessionReapInFlight = new Set()
}
const inFlight = globalForReaper.__idleSessionReapInFlight

// The scan above (statuses + config) can be stale by the time this runs for a
// given key -- a queued message could have started a turn in the meantime, in
// the window between that scan and this call. Re-derive status from a FRESH
// read right before killing and skip on anything but idle, rather than acting
// on what the scan saw a moment earlier.
async function reapOne(sessionKey: string): Promise<void> {
  if (inFlight.has(sessionKey)) {
    return
  }
  inFlight.add(sessionKey)
  try {
    // `background` is part of the status itself (live background work reads as
    // `working` — see deriveSessionStatus), so a session mid-delegation can
    // never classify as idle here: unloading it would kill that work silently.
    const fresh = deriveSessionStatus(sessionKey, {
      pending: new Set(agentClient.pendingPermissionSessionKeys()),
      active: new Set(agentClient.activeSessionKeys()),
      background: new Set(agentClient.backgroundWorkSessionKeys()),
      alive: new Set(agentClient.aliveSessionKeys()),
    })
    if (fresh !== 'idle') {
      return
    }
    await stopLocalSessionProcessImpl(sessionKey)
    console.log(`[idle-session-reaper] unloaded ${sessionKey}`)
  } catch (err) {
    console.error(`[idle-session-reaper] failed to unload ${sessionKey}`, err)
  } finally {
    inFlight.delete(sessionKey)
  }
}

async function tick(): Promise<void> {
  const sessions = agentClient
    .listSessions()
    .filter((meta): meta is typeof meta & { sessionKey: string } => Boolean(meta.sessionKey))
    .map((meta) => ({ sessionKey: meta.sessionKey, lastActivityAt: meta.lastActivityAt }))
  if (sessions.length === 0) {
    return
  }
  const statuses = currentStatuses(sessions.map((s) => s.sessionKey))
  const agentSlugs = new Set<string>()
  for (const session of sessions) {
    const agentSlug = ownerAgentSlug(session.sessionKey)
    if (agentSlug) {
      agentSlugs.add(agentSlug)
    }
  }
  const configs = await resolveAgentConfigs(agentSlugs)
  const due = selectDueSessions(sessions, statuses, (agentSlug) => configs.get(agentSlug) ?? null, Date.now())
  await Promise.all(due.map(reapOne))
}

export function startIdleSessionReaper(): void {
  if (globalForReaper.__IDLE_SESSION_REAPER__) {
    return
  }
  const timer = setInterval(() => {
    tick().catch((err) => {
      console.error('[idle-session-reaper] tick failed', err)
    })
  }, TICK_MS)
  globalForReaper.__IDLE_SESSION_REAPER__ = { timer }
  console.log(`[idle-session-reaper] started (tick every ${TICK_MS}ms)`)
}
