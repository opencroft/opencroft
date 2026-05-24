'use server';

import { remoteExec, resolveTerminalContext, shellQuote } from '@/app/(mcp)/api/mcp/tools';
import { approvalStore } from '@/lib/approval-store';
import { askUserStore } from '@/lib/ask-user-store';
import type { PendingApproval } from '@/lib/sse-events';

export async function readRemoteFile(target: string, space: string | undefined, path: string): Promise<string> {
  const { ctx } = await resolveTerminalContext({ target, space });
  return remoteExec(ctx, `cat ${shellQuote(path)}`);
}

export async function listPendingApprovals(spaceId?: string): Promise<PendingApproval[]> {
  return approvalStore.list(spaceId);
}

export async function approveRequest(id: string): Promise<boolean> {
  return approvalStore.approve(id);
}

export async function rejectRequest(id: string, reason: string): Promise<boolean> {
  return approvalStore.reject(id, reason.trim());
}

export async function getAutoApprove(): Promise<boolean> {
  return approvalStore.getAutoApprove();
}

export async function setAutoApprove(value: boolean): Promise<boolean> {
  approvalStore.setAutoApprove(value);
  return approvalStore.getAutoApprove();
}

// ── AskUser actions ──────────────────────────────────────────────────────

export async function answerAskUser(id: string, answers: Record<string, string>): Promise<boolean> {
  return askUserStore.answer(id, answers);
}

export async function cancelAskUser(id: string): Promise<boolean> {
  return askUserStore.cancel(id);
}
