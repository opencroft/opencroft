// Safe for both server and client — no runtime imports.
//
// Which edge feeds a node's input handle. The server resolving a node's inputs
// on save and the canvas resolving them live both answer through this, so one
// node cannot show one source in the page and act on another on the server.

interface InputEdge {
  target: string
  targetHandle?: string | null
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
