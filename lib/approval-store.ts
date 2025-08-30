// ── Approval Store ──────────────────────────────────────────────────────
//
// In-memory pending MCP approval requests. The wrapped tool handler awaits
// a Promise here; user actions (approve/reject) settle that Promise.

import type { PendingApproval } from '@/lib/sse-events';
import { toastStore } from '@/lib/toast-store';

interface PendingEntry {
  request: PendingApproval;
  resolve: () => void;
  reject: (reason: string) => void;
}

class ApprovalStore {
  private pending = new Map<string, PendingEntry>();

  add(request: PendingApproval): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { request, resolve, reject });
      toastStore.broadcast({
        type: 'approval_pending',
        request,
        spaceId: request.spaceId,
      });
    });
  }

  approve(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    this.pending.delete(id);
    toastStore.broadcast({ type: 'approval_resolved', id, spaceId: entry.request.spaceId });
    entry.resolve();
    return true;
  }

  reject(id: string, reason: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    this.pending.delete(id);
    toastStore.broadcast({ type: 'approval_resolved', id, spaceId: entry.request.spaceId });
    entry.reject(reason);
    return true;
  }

  /** Drop a request without resolving it (used when the MCP client disconnects). */
  cancel(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    this.pending.delete(id);
    toastStore.broadcast({ type: 'approval_resolved', id, spaceId: entry.request.spaceId });
    entry.reject('client cancelled');
    return true;
  }

  list(spaceId?: string): PendingApproval[] {
    const all = Array.from(this.pending.values()).map((e) => e.request);
    if (!spaceId) {
      return all;
    }
    return all.filter((r) => !r.spaceId || r.spaceId === spaceId);
  }
}

const g = globalThis as Record<string, unknown>;
if (!g.__APPROVAL_STORE__) {
  g.__APPROVAL_STORE__ = new ApprovalStore();
}
export const approvalStore = g.__APPROVAL_STORE__ as ApprovalStore;
