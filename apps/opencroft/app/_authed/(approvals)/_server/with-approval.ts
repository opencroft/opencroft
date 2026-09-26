import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { approvalStore } from '@/lib/approval-store'
import type { PendingApproval } from '@/lib/sse-events'

/** How one particular call of a tool is asked about. */
export interface CallApproval {
  gated: boolean
  view?: string
  /** The space the approval is shown in. */
  space?: string
}

interface ApprovalMeta {
  view?: string
  /**
   * For a tool whose effect depends on what it is asked to do — one tool
   * dispatching to many operations — the gate of this call, decided from its
   * arguments. Undefined from it keeps the tool's own gate, so an argument the
   * resolver cannot classify never lowers one.
   */
  forCall?: (args: Record<string, unknown>) => Promise<CallApproval | undefined>
}

const meta = new WeakMap<ToolHandler, ApprovalMeta>()

export function withApprovalRequired(handler: ToolHandler, options: ApprovalMeta = {}): ToolHandler {
  // Forwards the caller context untouched: a wrapped handler must not lose
  // track of who is calling just because it also needs approval.
  const wrapped: ToolHandler = (args, caller) => handler(args, caller)
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

export async function awaitApproval(input: {
  tool: string
  args: Record<string, unknown>
  view?: string
  signal?: AbortSignal
  spaceId?: string
}): Promise<void> {
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
