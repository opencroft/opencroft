'use server';

import { approvalStore } from '@/lib/approval-store';
import type { PendingApproval } from '@/lib/sse-events';

export async function listPendingApprovals(spaceId?: string): Promise<PendingApproval[]> {
  return approvalStore.list(spaceId);
}

export async function approveRequest(id: string): Promise<boolean> {
  return approvalStore.approve(id);
}

export async function rejectRequest(id: string, reason: string): Promise<boolean> {
  return approvalStore.reject(id, reason.trim());
}
