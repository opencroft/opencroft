import { createServerFn } from '@tanstack/react-start';

import { remoteExec, resolveTerminalContext, shellQuote } from '@/app/(mcp)/api/mcp/tools';
import { approvalStore } from '@/lib/approval-store';
import { askUserStore } from '@/lib/ask-user-store';
import type { PendingApproval } from '@/lib/sse-events';

export const readRemoteFile = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { target: string; space: string | undefined; path: string }) => data)
  .handler(async ({ data }): Promise<string> => {
    const { target, space, path } = data;
    const { ctx } = await resolveTerminalContext({ target, space });
    return remoteExec(ctx, `cat ${shellQuote(path)}`);
  });

export const listPendingApprovals = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((spaceId?: string) => spaceId)
  .handler(async ({ data: spaceId }): Promise<PendingApproval[]> => {
    return approvalStore.list(spaceId);
  });

export const approveRequest = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }): Promise<boolean> => {
    return approvalStore.approve(id);
  });

export const rejectRequest = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { id: string; reason: string }) => data)
  .handler(async ({ data }): Promise<boolean> => {
    const { id, reason } = data;
    return approvalStore.reject(id, reason.trim());
  });

export const getAutoApprove = createServerFn({ strict: { output: false } }).handler(async (): Promise<boolean> => {
  return approvalStore.getAutoApprove();
});

export const setAutoApprove = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((value: boolean) => value)
  .handler(async ({ data: value }): Promise<boolean> => {
    approvalStore.setAutoApprove(value);
    return approvalStore.getAutoApprove();
  });

// ── AskUser actions ──────────────────────────────────────────────────────

export const answerAskUser = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { id: string; answers: Record<string, string> }) => data)
  .handler(async ({ data }): Promise<boolean> => {
    const { id, answers } = data;
    return askUserStore.answer(id, answers);
  });

export const cancelAskUser = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }): Promise<boolean> => {
    return askUserStore.cancel(id);
  });
