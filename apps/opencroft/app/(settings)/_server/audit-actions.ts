import { createServerFn } from '@tanstack/react-start'

import type { AuditStatus } from '@/app/(mcp)/_server/audit'
import { getYoloModeInfo, setYoloMode as setYolo } from '@/app/(mcp)/_server/yolo'
import { prisma } from '@opencroft/db'

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

function toEntry(row: { id: string; tool: string; args: string; result: string | null; error: string | null; status: string; durationMs: number; createdAt: Date }): McpAuditEntry {
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
    const where: { tool?: string; status?: string } = {}
    if (query.tool) {
      where.tool = query.tool
    }
    if (query.status && query.status !== 'all') {
      where.status = query.status
    }
    const rows = await prisma.mcpAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? DEFAULT_LIMIT,
    })
    return rows.map(toEntry)
  })

export const listAuditTools = createServerFn().handler(async (): Promise<string[]> => {
  const rows = await prisma.mcpAuditLog.findMany({
    distinct: ['tool'],
    select: { tool: true },
    orderBy: { tool: 'asc' },
  })
  return rows.map((r) => r.tool)
})

export const clearAuditLog = createServerFn().handler(async (): Promise<void> => {
  await prisma.mcpAuditLog.deleteMany({})
})

// ── YOLO Mode ──────────────────────────────────────────────────────────────

export const getYoloMode = createServerFn().handler(async (): Promise<{ enabled: boolean; source: 'env' | 'runtime' }> => {
  return getYoloModeInfo()
})

export const updateYoloMode = createServerFn({ method: 'POST' })
  .inputValidator((enabled: boolean) => enabled)
  .handler(async ({ data: enabled }): Promise<void> => {
    setYolo(enabled)
  })
