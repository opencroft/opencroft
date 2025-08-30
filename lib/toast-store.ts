// ── SSE Toast Store ─────────────────────────────────────────────────────
//
// In-memory pub/sub for SSE events, grouped by spaceId.
// Subscribers without a spaceId receive all events.
// Subscribers with a spaceId receive events scoped to that space plus
// events broadcast globally (no spaceId on the event).
//
// Uses globalThis to survive Turbopack module isolation — each route handler
// gets its own module scope, but globalThis is shared across the process.

import type { SSEEvent } from '@/lib/sse-events';

interface Subscriber {
  spaceId: string | null;
  fn: (data: string) => void;
}

class ToastStore {
  private subscribers = new Set<Subscriber>();

  subscribe(fn: (data: string) => void, spaceId?: string): () => void {
    const sub: Subscriber = { spaceId: spaceId ?? null, fn };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  broadcast(event: SSEEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    const targetSpace = event.spaceId ?? null;
    for (const sub of this.subscribers) {
      if (targetSpace === null) {
        sub.fn(data);
        continue;
      }
      if (sub.spaceId === null || sub.spaceId === targetSpace) {
        sub.fn(data);
      }
    }
  }
}

const g = globalThis as Record<string, unknown>;
if (!g.__TOAST_STORE__) {
  g.__TOAST_STORE__ = new ToastStore();
}
export const toastStore = g.__TOAST_STORE__ as ToastStore;
