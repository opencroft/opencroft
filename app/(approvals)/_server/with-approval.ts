import { approvalStore } from '@/lib/approval-store'
import type { PendingApproval } from '@/lib/sse-events'

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>

interface ApprovalMeta {
  view?: string
}

const meta = new WeakMap<ToolHandler, ApprovalMeta>()

export function withApprovalRequired(handler: ToolHandler, options: ApprovalMeta = {}): ToolHandler {
  const wrapped: ToolHandler = (args) => handler(args)
  meta.set(wrapped, options)
  return wrapped
}

export function getApprovalMeta(handler: ToolHandler): ApprovalMeta | undefined {
  return meta.get(handler)
}

function nextRequestId(): string {
  return `apr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export class ApprovalRejectedError extends Error {
  constructor(public reason: string) {
    super(reason)
    this.name = 'ApprovalRejectedError'
  }
}

export async function awaitApproval(input: { tool: string; args: Record<string, unknown>; view?: string; signal?: AbortSignal; spaceId?: string }): Promise<void> {
  const request: PendingApproval = {
    id: nextRequestId(),
    tool: input.tool,
    args: input.args,
    view: input.view,
    spaceId: input.spaceId,
    createdAt: Date.now(),
  }
  const onAbort = () => approvalStore.cancel(request.id)
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await approvalStore.add(request)
  } catch (reason) {
    throw new ApprovalRejectedError(typeof reason === 'string' ? reason : String(reason))
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }
}
