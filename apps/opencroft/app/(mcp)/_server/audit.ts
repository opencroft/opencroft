import { prisma } from '@opencroft/db'

const MAX_PAYLOAD = 16384

export type AuditStatus = 'auto-approved' | 'approved' | 'rejected' | 'error'

function serialize(value: unknown): string {
  const text = JSON.stringify(value) ?? ''
  if (text.length <= MAX_PAYLOAD) {
    return text
  }
  return text.slice(0, MAX_PAYLOAD) + '…'
}

export interface AuditEntryInput {
  tool: string
  args: Record<string, unknown>
  status: AuditStatus
  result?: unknown
  error?: string
  durationMs: number
}

export async function recordAudit(input: AuditEntryInput): Promise<void> {
  await prisma.mcpAuditLog.create({
    data: {
      tool: input.tool,
      args: serialize(input.args),
      result: input.result === undefined ? null : serialize(input.result),
      error: input.error ?? null,
      status: input.status,
      durationMs: input.durationMs,
    },
  })
}
