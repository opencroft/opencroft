// Safe for both server and client — no runtime imports.
//
// Which edge feeds a node's input handle. The server resolving a node's inputs
// on save and the canvas resolving them live both answer through this, so one
// node cannot show one source in the page and act on another on the server.
// Which edges a new edge replaces is decided here too, for the canvas and
// connectNodes alike.

import { type ExtensionHandle, findExtensionHandle } from './_types'

interface InputEdge {
  target: string
  targetHandle?: string | null
}

/**
 * Whether the target handle `handleId` takes one edge: it is declared among
 * the node's `handles` without `multiple`. An undeclared handle is not, since
 * nothing says how many edges it takes.
 */
export function takesOneEdge(handles: readonly ExtensionHandle[], handleId: string): boolean {
  const handle = findExtensionHandle(handles, handleId, 'target')
  return handle !== undefined && !handle.multiple
}

/**
 * The edges a new edge replaces: those already into its target handle, when
 * that handle takes one edge (see `takesOneEdge`); none otherwise.
 */
export function edgesReplacedBy<E extends InputEdge>(
  edges: readonly E[],
  edge: InputEdge,
  handles: readonly ExtensionHandle[],
): E[] {
  const { targetHandle } = edge
  if (!targetHandle || !takesOneEdge(handles, targetHandle)) {
    return []
  }
  return edges.filter((e) => e.target === edge.target && e.targetHandle === targetHandle)
}

/**
 * The edges that feed their target handle, in the order given. A handle with
 * several edges is fed by the first of them in the graph's edge list — the
 * order the edges were created in — and the others feed nothing, even when the
 * first one's source resolves nothing. Edges without a target handle feed
 * nothing.
 */
export function feedingEdges<E extends InputEdge>(edges: readonly E[]): Array<E & { targetHandle: string }> {
  const fed = new Set<string>()
  return edges.filter((edge): edge is E & { targetHandle: string } => {
    if (!edge.targetHandle) {
      return false
    }
    const key = JSON.stringify([edge.target, edge.targetHandle])
    if (fed.has(key)) {
      return false
    }
    fed.add(key)
    return true
  })
}
