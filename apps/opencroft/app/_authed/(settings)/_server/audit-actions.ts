import { AdminActionError, requireAdminUser } from '@opencroft/auth/server'
import { db, mcpAuditLog } from '@opencroft/db'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, asc, desc, eq, type SQL } from 'drizzle-orm'

import type { AuditStatus } from '@/app/_authed/(mcp)/_server/audit'
import { getYoloModeInfo, setYoloMode as setYolo } from '@/app/_authed/(mcp)/_server/yolo'
import { getSleepModeInfo, setSleepMode as setSleep } from '@/app/_authed/(mcp)/_server/sleep-mode'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { deriveSessionStatus, type SessionStatus } from '@/app/_authed/(agent)/_shared/session-status'

export interface McpAuditEntry {
  id: string
  tool: string
  args: string
  result: string | null
  error: string | null
  status: AuditStatus
  durationMs: number
  createdAt: string
}

export interface AuditQuery {
  tool?: string
  status?: AuditStatus | 'all'
  limit?: number
}

const DEFAULT_LIMIT = 100

function toEntry(row: {
  id: string
  tool: string
  args: string
  result: string | null
  error: string | null
  status: string
  durationMs: number
  createdAt: Date
}): McpAuditEntry {
  return {
    id: row.id,
    tool: row.tool,
    args: row.args,
    result: row.result,
    error: row.error,
    status: row.status as AuditStatus,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  }
}

export const listAuditEntries = createServerFn({ method: 'POST' })
  .inputValidator((query: AuditQuery = {}) => query)
  .handler(async ({ data: query }): Promise<McpAuditEntry[]> => {
    const conds: SQL[] = []
    if (query.tool) {
      conds.push(eq(mcpAuditLog.tool, query.tool))
    }
    if (query.status && query.status !== 'all') {
      conds.push(eq(mcpAuditLog.status, query.status))
    }
    const rows = await db.query.mcpAuditLog.findMany({
      where: conds.length ? and(...conds) : undefined,
      orderBy: desc(mcpAuditLog.createdAt),
      limit: query.limit ?? DEFAULT_LIMIT,
    })
    return rows.map(toEntry)
  })

export const listAuditTools = createServerFn().handler(async (): Promise<string[]> => {
  const rows = await db.selectDistinct({ tool: mcpAuditLog.tool }).from(mcpAuditLog).orderBy(asc(mcpAuditLog.tool))
  return rows.map((r) => r.tool)
})

export const clearAuditLog = createServerFn().handler(async (): Promise<void> => {
  await db.delete(mcpAuditLog)
})

// ── YOLO Mode ──────────────────────────────────────────────────────────────

export const getYoloMode = createServerFn().handler(
  async (): Promise<{ enabled: boolean; source: 'env' | 'runtime' }> => {
    return getYoloModeInfo()
  },
)

export const updateYoloMode = createServerFn({ method: 'POST' })
  .inputValidator((enabled: boolean) => enabled)
  .handler(async ({ data: enabled }): Promise<void> => {
    setYolo(enabled)
  })


// `requireAdminUser` RETURNS the admin or null — it does not throw — so the
// result has to be acted on; a bare await with the value dropped type-checks
// and gates nothing. Same guard as the settings CRUD functions. A serverFn is
// a directly callable endpoint regardless of the page in front of it, and
// Sleep Mode is an instance-control lever: ungated, any caller who can reach
// the instance could hold every agent delivery.
async function requireAdmin(): Promise<void> {
  if (!(await requireAdminUser(getRequest()))) {
    throw new AdminActionError('forbidden', 'Only an administrator can control sleep mode')
  }
}

// ── Sleep Mode ─────────────────────────────────────────────────────────────

export interface SleepModeInfo {
  enabled: boolean
  markerPath: string
}

export const getSleepMode = createServerFn().handler(async (): Promise<SleepModeInfo> => getSleepModeInfo())

export const updateSleepMode = createServerFn({ method: 'POST' })
  .inputValidator((enabled: boolean) => enabled)
  .handler(async ({ data: enabled }): Promise<SleepModeInfo> => {
    await requireAdmin()
    setSleep(enabled)
    return getSleepModeInfo()
  })

// ── Live sessions (everything except Offline) ──────────────────────────────

export interface LiveSessionRow {
  key: string
  title: string
  status: Exclude<SessionStatus, 'offline'>
  queuedMessages: number
  lastActivityAt: number
}

// The page's question is "can I restart now", and STATE is the field that
// answers it — context size and queue depth read the same for a session deep
// in work and one that stopped an hour ago. Status comes from the same
// derivation every chat list uses (session-status.ts), off the same activity
// sets, rather than a second reading that could disagree with it.
export const listLiveSessions = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<LiveSessionRow[]> => {
    // Session keys and live activity are an instance map — admin-only, like
    // the lever above them.
    await requireAdmin()
    const keys = {
      pending: new Set(agentClient.pendingPermissionSessionKeys()),
      active: new Set(agentClient.activeSessionKeys()),
      alive: new Set(agentClient.aliveSessionKeys()),
    }
    const rows: LiveSessionRow[] = []
    for (const meta of agentClient.listSessions()) {
      // The activity sets are keyed by session key; a session without one
      // cannot be classified against them and is left out rather than shown
      // with a guessed state. Every session the app opens carries its key.
      if (!meta.sessionKey) {
        continue
      }
      const status = deriveSessionStatus(meta.sessionKey, keys)
      if (status === 'offline') {
        continue
      }
      rows.push({
        key: meta.sessionKey,
        title: meta.title,
        status,
        queuedMessages: meta.queuedMessages ?? 0,
        lastActivityAt: meta.lastActivityAt,
      })
    }
    rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    return rows
  },
)
