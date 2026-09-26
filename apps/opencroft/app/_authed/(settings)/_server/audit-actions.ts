import { db, mcpAuditLog } from '@opencroft/db'
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, type SQL } from 'drizzle-orm'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { sessionActivitySets } from '@/app/_authed/(agent)/_server/session-activity'
import { deriveSessionStatus, type SessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import { type BackgroundTaskList, backgroundTaskList } from '@/app/_authed/(background-tasks)/_server/task-list'
import type { AuditStatus } from '@/app/_authed/(mcp)/_server/audit'
import { getSleepModeInfo, setSleepMode as setSleep } from '@/app/_authed/(mcp)/_server/sleep-mode'
import { getYoloModeInfo, setYoloMode as setYolo } from '@/app/_authed/(mcp)/_server/yolo'
import { adminOnly } from '@/app/_authed/(settings)/_server/admin-middleware'

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
  .middleware([adminOnly])
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

export const listAuditTools = createServerFn()
  .middleware([adminOnly])
  .handler(async (): Promise<string[]> => {
    const rows = await db.selectDistinct({ tool: mcpAuditLog.tool }).from(mcpAuditLog).orderBy(asc(mcpAuditLog.tool))
    return rows.map((r) => r.tool)
  })

export const clearAuditLog = createServerFn()
  .middleware([adminOnly])
  .handler(async (): Promise<void> => {
    await db.delete(mcpAuditLog)
  })

// ── YOLO Mode ──────────────────────────────────────────────────────────────

export const getYoloMode = createServerFn()
  .middleware([adminOnly])
  .handler(async (): Promise<{ enabled: boolean; source: 'env' | 'runtime' }> => {
    return getYoloModeInfo()
  })

export const updateYoloMode = createServerFn({ method: 'POST' })
  .middleware([adminOnly])
  .inputValidator((enabled: boolean) => enabled)
  .handler(async ({ data: enabled }): Promise<void> => {
    setYolo(enabled)
  })

// ── Sleep Mode ─────────────────────────────────────────────────────────────

export interface SleepModeInfo {
  enabled: boolean
  markerPath: string
}

export const getSleepMode = createServerFn()
  .middleware([adminOnly])
  .handler(async (): Promise<SleepModeInfo> => getSleepModeInfo())

// Sleep Mode is an instance-control lever: ungated, any caller who can reach
// the instance could hold every agent delivery.
export const updateSleepMode = createServerFn({ method: 'POST' })
  .middleware([adminOnly])
  .inputValidator((enabled: boolean) => enabled)
  .handler(async ({ data: enabled }): Promise<SleepModeInfo> => {
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
// Session keys and live activity are an instance map — admin-only, like the
// lever above them.
export const listLiveSessions = createServerFn({ method: 'GET', strict: { output: false } })
  .middleware([adminOnly])
  .handler(async (): Promise<LiveSessionRow[]> => {
    const keys = sessionActivitySets()
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
  })

// ── Background tasks ───────────────────────────────────────────────────────

export type { BackgroundTaskList, BackgroundTaskRow } from '@/app/_authed/(background-tasks)/_server/task-list'

// The work sessions leave behind, for the question the sessions above answer.
// A background task's target and session are the same instance map — admin-only.
export const listBackgroundTasks = createServerFn({ method: 'GET', strict: { output: false } })
  .middleware([adminOnly])
  .handler(async (): Promise<BackgroundTaskList> => backgroundTaskList())
