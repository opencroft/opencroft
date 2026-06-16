import { db, mcpAuditLog } from '@opencroft/db'
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, type SQL } from 'drizzle-orm'

import type { AuditStatus } from '@/app/(mcp)/_server/audit'
import { getYoloModeInfo, setYoloMode as setYolo } from '@/app/(mcp)/_server/yolo'

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
  const rows = db.selectDistinct({ tool: mcpAuditLog.tool }).from(mcpAuditLog).orderBy(asc(mcpAuditLog.tool)).all()
  return rows.map((r) => r.tool)
})

export const clearAuditLog = createServerFn().handler(async (): Promise<void> => {
  db.delete(mcpAuditLog).run()
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
