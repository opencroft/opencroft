'use client'

import { useEffect, useState } from 'react'

import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { describeGraphRefs as describeGraphRefsOnServer } from '@/app/_authed/(extension-runtime)/_server/actions'
import type { GraphRefInfo } from '@/app/_authed/(extension-runtime)/_server/graph-refs'
import { findExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { sseEventsStore } from '@/app/_authed/(sse)/_lib/sse-events-store'

// Every ref asked for in the same tick goes out as ONE request: a list of
// NodeRef/TerminalRef rows mounts together, and one round trip per row is the
// cost this batching exists to avoid.
const pending = new Map<string, Array<(info: GraphRefInfo | null) => void>>()
let scheduled = false

// Answers are reused briefly, so a list that re-mounts (a tab switch, a
// re-opened inspector) does not ask again -- and only briefly, so a rename
// shows up the next time the ref mounts rather than never.
const FRESH_MS = 5000
const answered = new Map<string, { at: number; info: GraphRefInfo | null }>()

function flush(): void {
  scheduled = false
  const batch = new Map(pending)
  pending.clear()
  const settle = (answers: Record<string, GraphRefInfo | null>) => {
    const at = Date.now()
    for (const [id, waiters] of batch) {
      const info = answers[id] ?? null
      answered.set(id, { at, info })
      for (const resolve of waiters) {
        resolve(info)
      }
    }
  }
  describeGraphRefsOnServer({ data: { ids: [...batch.keys()] } })
    .then(settle)
    .catch(() => settle({}))
}

function describe(id: string): Promise<GraphRefInfo | null> {
  const known = answered.get(id)
  if (known && Date.now() - known.at < FRESH_MS) {
    return Promise.resolve(known.info)
  }
  return new Promise((resolve) => {
    const waiters = pending.get(id)
    if (waiters) {
      waiters.push(resolve)
    } else {
      pending.set(id, [resolve])
    }
    if (!scheduled) {
      scheduled = true
      setTimeout(flush, 0)
    }
  })
}

const graphRefListeners = new Set<() => void>()

// A graph change can rename or remove what an answer described, so it ends
// every answer's freshness rather than waiting out FRESH_MS.
let seenGraphVersion = sseEventsStore.getSnapshot().graphVersion
sseEventsStore.subscribe(() => {
  const { graphVersion } = sseEventsStore.getSnapshot()
  if (graphVersion !== seenGraphVersion) {
    seenGraphVersion = graphVersion
    answered.clear()
    for (const listener of graphRefListeners) {
      listener()
    }
  }
})

/** Called whenever the graph changed, so descriptions read before may be stale. */
export function subscribeGraphRefs(listener: () => void): () => void {
  graphRefListeners.add(listener)
  return () => {
    graphRefListeners.delete(listener)
  }
}

/** A graph reference as a reader is shown it -- see `describeGraphRefs`. */
export interface GraphRefDescription {
  kind: 'node' | 'app'
  /** The name its owner gave it, else its type's name. */
  name: string
  /** For a terminal target: which of the node's terminals, when that needs saying. */
  detail?: string
  /** Lucide icon name of its type. */
  icon?: string
  accent?: string
  /** The node type's name, or `App`. */
  typeName: string
  spaceSlug: string
}

/** Splits a "node-id/handle-id" terminal target; a bare id has no handle. */
export function splitTarget(target: string): { nodeId: string; handleId: string } {
  const slash = target.indexOf('/')
  return slash > 0
    ? { nodeId: target.slice(0, slash), handleId: target.slice(slash + 1) }
    : { nodeId: target, handleId: '' }
}

// What tells this terminal apart from its node's other outputs: a dynamic
// handle's expanded remainder (a container), or what an App calls the handle
// (a worktree's "repo · name") when it was asked as a target. A node's one plain
// terminal output needs nothing -- its label would only repeat "Terminal" --
// so a static label is shown only when the node has several to choose from.
function handleDetail(info: GraphRefInfo, handleId: string): string {
  if (!handleId) {
    return ''
  }
  if (info.kind !== 'node') {
    return info.handleLabels?.[handleId] ?? (handleId === 'terminal' ? '' : handleId)
  }
  const handles = extensionRegistry.resolveNode(info.type)?.handles ?? []
  const handle = findExtensionHandle(handles, handleId, 'source')
  if (!handle) {
    return handleId
  }
  if (handle.dynamic) {
    return handleId.slice(handle.id.length)
  }
  const plainTerminals = handles.filter((h) => h.role === 'source' && h.handleType === handle.handleType && !h.dynamic)
  return plainTerminals.length > 1 ? (handle.label ?? handleId) : ''
}

export function describeGraphRef(info: GraphRefInfo, handleId = ''): GraphRefDescription {
  const detail = handleDetail(info, handleId) || undefined
  if (info.kind === 'app') {
    return { kind: 'app', name: info.name, detail, icon: 'AppWindow', typeName: 'App', spaceSlug: info.spaceSlug }
  }
  // The resolved type for what the canvas shows (its accent, with the
  // registry's default); the declaration for the icon's name, which the
  // resolved type has already turned into a component.
  const type = extensionRegistry.resolveNode(info.type)
  return {
    kind: 'node',
    // The same fallback the canvas outline uses for an unnamed node.
    name: info.name || type?.name || info.type,
    detail,
    icon: type?.extension.nodes?.[type.nodeIndex]?.icon,
    accent: type?.accent,
    typeName: type?.name ?? info.type,
    spaceSlug: info.spaceSlug,
  }
}

/**
 * Node ids, App instance ids / `<space>.<app-slug>` addresses and
 * "node-id/handle-id" terminal targets, described for showing by name, across
 * every space; null for one nothing answers to. Every ref asked for in the same
 * tick, by any caller, goes out as one request.
 */
export async function describeGraphRefs(refs: string[]): Promise<Record<string, GraphRefDescription | null>> {
  const entries = await Promise.all(
    refs.map(async (ref) => {
      // Asked whole, so an App's answer can carry its name for the handle.
      const info = await describe(ref)
      return [ref, info ? describeGraphRef(info, splitTarget(ref).handleId) : null] as const
    }),
  )
  return Object.fromEntries(entries)
}

export type GraphRefState = { status: 'loading' } | { status: 'known'; info: GraphRefInfo } | { status: 'unknown' }

/**
 * What a node / App instance id stands for, resolved across every space. A
 * "node-id/handle-id" terminal target resolves to its owner, carrying an App's
 * name for the handle.
 */
export function useGraphRef(id: string): GraphRefState {
  const [state, setState] = useState<GraphRefState>({ status: 'loading' })
  useEffect(() => {
    if (!id) {
      setState({ status: 'unknown' })
      return
    }
    let current = true
    setState({ status: 'loading' })
    describe(id).then((info) => {
      if (current) {
        setState(info ? { status: 'known', info } : { status: 'unknown' })
      }
    })
    return () => {
      current = false
    }
  }, [id])
  return state
}
