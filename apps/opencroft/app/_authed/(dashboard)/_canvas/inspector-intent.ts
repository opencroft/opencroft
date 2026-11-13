'use client'

import { useSyncExternalStore } from 'react'

// What the inspector shows, kept for the life of the page.
//
// `tab` is remembered per node type (the qualified `<owner>.<extension>.<type>`),
// whoever set it: a button on a node (`open`), or the inspector's own tab strip
// (`setTab`). Selecting another node of the same type opens it on the same
// tab, so the same view can be compared across nodes. The inspector reads it
// rather than keeping a copy, and when the node has no such tab it shows its
// first tab without changing what is remembered.
//
// `instanceId` (which of the node's containers or terminals its tabs show) is
// kept per node: its values name things only that node has.
export interface InspectorIntent {
  tab?: string
  instanceId?: string
  tabRequestId?: number
}

interface NodeIntent {
  instanceId?: string
  tabRequestId?: number
}

/** A node's qualified type, as a canvas holding the node knows it; undefined for a node it does not hold. */
type NodeTypeLookup = (nodeId: string) => string | undefined

const EMPTY: InspectorIntent = {}
const tabsByType = new Map<string, string>()
const nodeIntents = new Map<string, NodeIntent>()
// The last snapshot handed out per node, so an unchanged intent keeps its
// identity, as useSyncExternalStore requires.
const snapshots = new Map<string, InspectorIntent>()
const typeLookups = new Set<NodeTypeLookup>()
const listeners = new Set<() => void>()
const openListeners = new Set<(nodeId: string) => void>()
let nextRequest = 0

function emit(): void {
  for (const l of listeners) {
    l()
  }
}

function typeOf(nodeId: string): string | undefined {
  for (const lookup of typeLookups) {
    const type = lookup(nodeId)
    if (type) {
      return type
    }
  }
  return undefined
}

function snapshot(nodeId: string): InspectorIntent {
  const own = nodeIntents.get(nodeId)
  const type = typeOf(nodeId)
  const tab = type ? tabsByType.get(type) : undefined
  if (!own && tab === undefined) {
    return EMPTY
  }
  const prev = snapshots.get(nodeId)
  if (prev && prev.tab === tab && prev.instanceId === own?.instanceId && prev.tabRequestId === own?.tabRequestId) {
    return prev
  }
  const next: InspectorIntent = { ...own, ...(tab === undefined ? {} : { tab }) }
  snapshots.set(nodeId, next)
  return next
}

function patchNode(nodeId: string, partial: NodeIntent): void {
  nodeIntents.set(nodeId, { ...nodeIntents.get(nodeId), ...partial })
}

function rememberTab(nodeId: string, tab: string): void {
  const type = typeOf(nodeId)
  if (type) {
    tabsByType.set(type, tab)
  }
}

export const inspectorIntent = {
  get: snapshot,
  /**
   * Shows `nodeId` in the inspector on `tab`: the canvas holding the node
   * selects it alone and brings it into view (`onOpen`), so a caller does not
   * select it first. The tab becomes the one remembered for the node's type.
   */
  open(nodeId: string, tab: string, instanceId?: string): void {
    nextRequest += 1
    rememberTab(nodeId, tab)
    patchNode(nodeId, { instanceId, tabRequestId: nextRequest })
    emit()
    for (const l of openListeners) {
      l(nodeId)
    }
  },
  /** The tab picked in the inspector's own tab strip, remembered for the node's type. */
  setTab(nodeId: string, tab: string): void {
    rememberTab(nodeId, tab)
    emit()
  },
  setInstance(nodeId: string, instanceId: string | undefined): void {
    patchNode(nodeId, { instanceId })
    emit()
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
  /** Called on every `open`, with the node that asked. The canvas uses it to select and show the node. */
  onOpen(cb: (nodeId: string) => void): () => void {
    openListeners.add(cb)
    return () => {
      openListeners.delete(cb)
    }
  },
}

/**
 * Tells the store the types of the nodes a canvas holds, so a request that
 * names only a node (`open`, `setTab`) reaches its type's tab. Returns the
 * unregister. Host-only: extensions are not given it.
 */
export function registerNodeTypes(lookup: NodeTypeLookup): () => void {
  typeLookups.add(lookup)
  emit()
  return () => {
    typeLookups.delete(lookup)
    emit()
  }
}

/** The inspector's own reads and writes, which know the node's type. */
export const inspectorTabs = {
  get: (type: string): string | undefined => tabsByType.get(type),
  set(type: string, tab: string): void {
    tabsByType.set(type, tab)
    emit()
  },
}

export function useInspectorIntent(nodeId: string): InspectorIntent {
  return useSyncExternalStore(
    inspectorIntent.subscribe,
    () => snapshot(nodeId),
    () => EMPTY,
  )
}

/** The tab remembered for nodes of `type`; undefined until one is picked or opened. */
export function useInspectorTab(type: string): string | undefined {
  return useSyncExternalStore(
    inspectorIntent.subscribe,
    () => tabsByType.get(type),
    () => undefined,
  )
}
