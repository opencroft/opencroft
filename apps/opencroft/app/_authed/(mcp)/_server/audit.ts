import { db, mcpAuditLog } from '@opencroft/db'

const MAX_PAYLOAD = 16384

export type AuditStatus = 'auto-approved' | 'approved' | 'rejected' | 'error'

// A private key's armor, from its BEGIN line to the end of the JSON string that
// holds it: PEM has no `"`, and a `"` inside a JSON string is escaped as `\"`.
// A call carries one as a parameter (a Key Store's `import`, a file written
// with remote_write), and the log is in every backup of the database.
const PRIVATE_KEY_ARMOR = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^"]*/g

/** `value` as JSON, private keys replaced. */
export function serialize(value: unknown): string {
  const text = (JSON.stringify(value) ?? '').replace(PRIVATE_KEY_ARMOR, '[private key redacted]')
  if (text.length <= MAX_PAYLOAD) {
    return text
  }
  return `${text.slice(0, MAX_PAYLOAD)}…`
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
  await db.insert(mcpAuditLog).values({
    tool: input.tool,
    args: serialize(input.args),
    result: input.result === undefined ? null : serialize(input.result),
    error: input.error ?? null,
    status: input.status,
    durationMs: input.durationMs,
  })
}
