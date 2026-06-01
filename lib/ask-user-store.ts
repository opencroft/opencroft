// ── AskUser Store ──────────────────────────────────────────────────────
//
// In-memory pending AskUser requests. The MCP tool handler awaits
// a Promise here; user actions (answer) settle that Promise.

import type { PendingAskUser } from '@/lib/sse-events'
import { toastStore } from '@/lib/toast-store'

interface PendingEntry {
  request: PendingAskUser
  resolve: (answers: Record<string, string>) => void
  reject: (reason: string) => void
}

class AskUserStore {
  private pending = new Map<string, PendingEntry>()

  add(request: PendingAskUser): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { request, resolve, reject })
      toastStore.broadcast({
        type: 'ask_user_pending',
        request,
        spaceId: request.spaceId,
      })
    })
  }

  answer(id: string, answers: Record<string, string>): boolean {
    const entry = this.pending.get(id)
    if (!entry) {
      return false
    }
    this.pending.delete(id)
    toastStore.broadcast({ type: 'ask_user_resolved', id, spaceId: entry.request.spaceId })
    entry.resolve(answers)
    return true
  }

  cancel(id: string): boolean {
    const entry = this.pending.get(id)
    if (!entry) {
      return false
    }
    this.pending.delete(id)
    toastStore.broadcast({ type: 'ask_user_resolved', id, spaceId: entry.request.spaceId })
    entry.reject('cancelled')
    return true
  }

  get(id: string): PendingAskUser | undefined {
    return this.pending.get(id)?.request
  }

  list(spaceId?: string): PendingAskUser[] {
    const all = Array.from(this.pending.values()).map((e) => e.request)
    if (!spaceId) {
      return all
    }
    return all.filter((r) => !r.spaceId || r.spaceId === spaceId)
  }
}

const g = globalThis as Record<string, unknown>
if (!g.__ASK_USER_STORE__) {
  g.__ASK_USER_STORE__ = new AskUserStore()
}
export const askUserStore = g.__ASK_USER_STORE__ as AskUserStore
