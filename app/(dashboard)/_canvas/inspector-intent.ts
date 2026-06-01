'use client'

import { useSyncExternalStore } from 'react'

export interface InspectorIntent {
  tab?: string
  instanceId?: string
  tabRequestId?: number
}

const EMPTY: InspectorIntent = {}
const store = new Map<string, InspectorIntent>()
const listeners = new Set<() => void>()
let nextRequest = 0

function emit(): void {
  for (const l of listeners) {
    l()
  }
}

function snapshot(nodeId: string): InspectorIntent {
  return store.get(nodeId) ?? EMPTY
}

function patch(nodeId: string, partial: Partial<InspectorIntent>): void {
  const prev = store.get(nodeId) ?? EMPTY
  store.set(nodeId, { ...prev, ...partial })
  emit()
}

export const inspectorIntent = {
  get: snapshot,
  open(nodeId: string, tab: string, instanceId?: string): void {
    nextRequest += 1
    patch(nodeId, { tab, instanceId, tabRequestId: nextRequest })
  },
  setInstance(nodeId: string, instanceId: string | undefined): void {
    patch(nodeId, { instanceId })
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
}

export function useInspectorIntent(nodeId: string): InspectorIntent {
  return useSyncExternalStore(
    inspectorIntent.subscribe,
    () => snapshot(nodeId),
    () => EMPTY,
  )
}
