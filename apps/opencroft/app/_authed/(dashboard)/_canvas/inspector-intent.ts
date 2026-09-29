'use client'

import { useSyncExternalStore } from 'react'

// What the inspector shows for a node, kept per node for the life of the page.
//
// `tab` is the node's current inspector tab, whoever set it: a button on the
// node (`open`), or the inspector's own tab strip (`setTab`). The inspector
// reads it rather than keeping a copy, so reselecting a node shows the tab it
// was last on, and a remount of the panel loses nothing.
export interface InspectorIntent {
  tab?: string
  instanceId?: string
  tabRequestId?: number
}

const EMPTY: InspectorIntent = {}
const store = new Map<string, InspectorIntent>()
const listeners = new Set<() => void>()
const openListeners = new Set<(nodeId: string) => void>()
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
  /** A node asking for the inspector on one of its tabs. */
  open(nodeId: string, tab: string, instanceId?: string): void {
    nextRequest += 1
    patch(nodeId, { tab, instanceId, tabRequestId: nextRequest })
    for (const l of openListeners) {
      l(nodeId)
    }
  },
  /** The tab picked in the inspector's own tab strip. */
  setTab(nodeId: string, tab: string): void {
    patch(nodeId, { tab })
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
  /** Called on every `open`, with the node that asked. The canvas uses it to bring the inspector into view. */
  onOpen(cb: (nodeId: string) => void): () => void {
    openListeners.add(cb)
    return () => {
      openListeners.delete(cb)
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
