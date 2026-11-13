// The handles a node's edges name and the node doesn't draw: the input of a
// placeholder that isn't in the template, the output of a deleted Switch case. The card draws
// each as a stale pin, so its edge stays visible and a double-click removes it.
//
// Kept apart from the component so it can be exercised directly — that module
// pulls in a design-kit component, which a plain test runner cannot load.

import type { EdgeEnds } from './edge-handles'

export type HandleRole = 'source' | 'target'

/**
 * The handles the flow library measured on a node, by role. It is undefined
 * until the node is first measured, and a role is null when the node draws no
 * handle of that role.
 */
export type MeasuredHandles = Partial<Record<HandleRole, readonly { id?: string | null }[] | null>> | undefined

/**
 * The ids of `role` the node's edges name and its own handles don't.
 * `stalePinIds` holds `<role>:<id>` for each stale pin already drawn, whose
 * handle stands in for the missing one and so doesn't count as the node's.
 */
export function staleHandleIds(
  measured: MeasuredHandles,
  role: HandleRole,
  edges: readonly EdgeEnds[],
  nodeId: string | null,
  stalePinIds: ReadonlySet<string>,
): string[] {
  // Before the first measure nothing is known, and every edge would read stale.
  if (!nodeId || !measured) {
    return []
  }
  const drawn = new Map<string, number>()
  for (const h of measured[role] ?? []) {
    if (h.id) {
      drawn.set(h.id, (drawn.get(h.id) ?? 0) + 1)
    }
  }
  // A stale pin draws a handle of its own under the id it stands for, which
  // does not count. A second handle under that id does: the node declared the
  // handle after its edge arrived (a port made by connecting to it, whose edge
  // and handle land in one render, before the handle is measured).
  const registered = new Set<string>()
  for (const [id, count] of drawn) {
    if (count > (stalePinIds.has(`${role}:${id}`) ? 1 : 0)) {
      registered.add(id)
    }
  }
  const stale = new Set<string>()
  for (const edge of edges) {
    const handleId = role === 'source' ? edge.sourceHandle : edge.targetHandle
    const end = role === 'source' ? edge.source : edge.target
    if (end === nodeId && handleId && !registered.has(handleId)) {
      stale.add(handleId)
    }
  }
  return [...stale]
}
