'use client'

import { useSyncExternalStore } from 'react'

import type { SessionActivitySnapshot } from '@/lib/sse-events'

export interface SessionActivityKeys {
  pendingKeys: Set<string>
  activeKeys: Set<string>
  backgroundKeys: Set<string>
  aliveKeys: Set<string>
}

const EMPTY_SNAPSHOT: SessionActivityKeys = {
  pendingKeys: new Set(),
  activeKeys: new Set(),
  backgroundKeys: new Set(),
  aliveKeys: new Set(),
}

let snapshot: SessionActivityKeys = EMPTY_SNAPSHOT
const listeners = new Set<() => void>()

/**
 * Take the picture the server pushed on the page's event stream. Each one is
 * whole (see SessionActivitySnapshot), and every stream opens with one, so a
 * reconnect replaces whatever was held rather than patching it. While the
 * stream is down the last picture stays.
 */
export function receiveSessionActivity(activity: SessionActivitySnapshot): void {
  snapshot = {
    pendingKeys: new Set(activity.pending),
    activeKeys: new Set(activity.active),
    backgroundKeys: new Set(activity.background),
    aliveKeys: new Set(activity.alive),
  }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): SessionActivityKeys {
  return snapshot
}

// Each chat list's process-visibility indicator: blocked on someone — a
// permission request or a question (pending), a turn actively running
// (active), background work running (background), or a live agent process at
// all (alive — a superset of the others). Pushed by the server as it changes,
// so reading it costs no request however many surfaces do.
export function useSessionActivityKeys(): SessionActivityKeys {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT)
}
