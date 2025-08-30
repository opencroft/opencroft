'use server';

import type { AuditStatus } from '@/app/(mcp)/api/mcp/audit';
import { prisma } from '@/server/prisma';

export interface McpAuditEntry {
  id: string;
  tool: string;
  args: string;
  result: string | null;
  error: string | null;
  status: AuditStatus;
  durationMs: number;
  createdAt: string;
}

export interface AuditQuery {
  tool?: string;
  status?: AuditStatus | 'all';
  limit?: number;
}

const DEFAULT_LIMIT = 100;

function toEntry(row: {
  id: string;
  tool: string;
  args: string;
  result: string | null;
  error: string | null;
  status: string;
  durationMs: number;
  createdAt: Date;
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
  };
}

export async function listAuditEntries(query: AuditQuery = {}): Promise<McpAuditEntry[]> {
  const where: { tool?: string; status?: string } = {};
  if (query.tool) {
    where.tool = query.tool;
  }
  if (query.status && query.status !== 'all') {
    where.status = query.status;
  }
  const rows = await prisma.mcpAuditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: query.limit ?? DEFAULT_LIMIT,
  });
  return rows.map(toEntry);
}

export async function listAuditTools(): Promise<string[]> {
  const rows = await prisma.mcpAuditLog.findMany({
    distinct: ['tool'],
    select: { tool: true },
    orderBy: { tool: 'asc' },
  });
  return rows.map((r) => r.tool);
}

export async function clearAuditLog(): Promise<void> {
  await prisma.mcpAuditLog.deleteMany({});
}
