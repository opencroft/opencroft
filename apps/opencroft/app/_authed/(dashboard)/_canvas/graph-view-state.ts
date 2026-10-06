import type { Edge, Node } from '@xyflow/react'

import { jsonEqual } from '@/app/_authed/(space)/_lib/graph-doc'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

// The line between the graph and one tab's view of it. `selected` and
// `dragging` belong to the tab looking at the canvas; a save that carried them
// brought a node back on the next load as one nobody had picked, and a resync
// handed one tab another writer's selection.

/** What a write carries: comments are drawn from SSE state, not the graph, and the view flags stay here. */
export function persistedNodes(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.type !== 'comment').map(({ selectable, selected, dragging, ...rest }) => rest)
}

/**
 * What a live write carries: the tab's nodes and edges without its view
 * state. Selection is dropped, and so is the size this tab measured: each
 * browser measures for itself, so a node's `measured` keeps whatever `base`
 * -- the graph the tab's state came from -- holds for it, and a write never
 * changes it.
 */
export function liveGraphOf(nodes: Node[], edges: Edge[], base: GraphData): GraphData {
  const measuredInBase = new Map(base.nodes.map((n) => [n.id, n.measured]))
  return {
    nodes: persistedNodes(nodes).map(({ measured, ...rest }) => {
      const stored = measuredInBase.get(rest.id)
      return stored === undefined ? rest : { ...rest, measured: stored }
    }) as unknown as GraphData['nodes'],
    edges: edges.map(({ selected, ...rest }) => rest) as unknown as GraphData['edges'],
  }
}

/**
 * This tab's nodes after a change it did not make reached the live graph;
 * `before` and `after` are the graph before and after that change.
 *
 * A node the change left alone keeps this tab's copy, so an edit not yet
 * written and a drag in progress survive. One it changed takes the new version
 * under this tab's selection and measured size, unless it is being dragged
 * here. One it removed goes; one this tab added and has not written yet stays,
 * as do comment nodes, which are never part of the graph.
 */
export function mergeRemoteNodes(before: GraphData, after: GraphData, current: Node[]): Node[] {
  const merged = mergeElements(before.nodes, after.nodes, current, (incoming, mine) =>
    mine?.dragging
      ? mine
      : ({
          ...incoming,
          selected: mine?.selected ?? false,
          ...(mine?.measured ? { measured: mine.measured } : {}),
        } as Node),
  )
  return [...merged, ...current.filter((n) => n.type === 'comment')]
}

/** This tab's edges after a change it did not make; see mergeRemoteNodes. */
export function mergeRemoteEdges(before: GraphData, after: GraphData, current: Edge[]): Edge[] {
  return mergeElements(
    before.edges,
    after.edges,
    current,
    (incoming, mine) => ({ ...incoming, selected: mine?.selected ?? false }) as Edge,
  )
}

function mergeElements<T extends { id: string; type?: string }>(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
  current: T[],
  take: (incoming: Record<string, unknown>, mine: T | undefined) => T,
): T[] {
  const was = new Map(before.map((e) => [e.id, e]))
  const now = new Set(after.map((e) => e.id))
  const mine = new Map(current.map((e) => [e.id, e]))
  const merged = after.map((incoming) => {
    const own = mine.get(incoming.id as string)
    const unchanged = own && was.has(incoming.id) && jsonEqual(was.get(incoming.id), incoming)
    return unchanged ? own : take(incoming, own)
  })
  const unwritten = current.filter((e) => e.type !== 'comment' && !now.has(e.id) && !was.has(e.id))
  return [...merged, ...unwritten]
}

/** A fetched graph under the selection this tab already has, whatever the rows say. */
export function withCurrentSelection(incoming: Node[], current: Node[]): Node[] {
  const selected = new Set(current.filter((n) => n.selected).map((n) => n.id))
  return incoming.map((n) => ({ ...n, selected: selected.has(n.id) }))
}
