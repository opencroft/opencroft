import type { Node } from '@xyflow/react'

// The line between the graph and one tab's view of it. `selected` and
// `dragging` belong to the tab looking at the canvas; a save that carried them
// brought a node back on the next load as one nobody had picked, and a resync
// handed one tab another writer's selection.

/** What a save carries: comments are drawn from SSE state, not the graph, and the view flags stay here. */
export function persistedNodes(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.type !== 'comment').map(({ selectable, selected, dragging, ...rest }) => rest)
}

/** A fetched graph under the selection this tab already has, whatever the rows say. */
export function withCurrentSelection(incoming: Node[], current: Node[]): Node[] {
  const selected = new Set(current.filter((n) => n.selected).map((n) => n.id))
  return incoming.map((n) => ({ ...n, selected: selected.has(n.id) }))
}
