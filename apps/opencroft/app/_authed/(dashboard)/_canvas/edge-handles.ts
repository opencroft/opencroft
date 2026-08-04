// The anchors a node needs, read from the edges attached to it.
//
// A node's handles are declared by its extension, so a node whose extension has
// not arrived declares none — and an edge naming a handle that does not exist
// has nothing to attach to. The edges are the way out: each one records the
// handle id it expects at each end, so the ids referenced for a given node are
// exactly the anchors the graph needs, knowable without knowing anything about
// the extension that will eventually supply them.
//
// Kept apart from the component so it can be exercised directly — that module
// pulls in a design-kit component, which a plain test runner cannot load.

/** Only the fields this needs; the flow library's edge carries far more. */
export interface EdgeEnds {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export function edgeHandleIds(
  edges: readonly EdgeEnds[],
  nodeId: string | null,
): { source: string[]; target: string[] } {
  const source = new Set<string>()
  const target = new Set<string>()
  if (!nodeId) {
    return { source: [], target: [] }
  }
  for (const edge of edges) {
    // A node can be both ends of the same edge, so these are separate checks
    // rather than branches of one.
    if (edge.source === nodeId && edge.sourceHandle) {
      source.add(edge.sourceHandle)
    }
    if (edge.target === nodeId && edge.targetHandle) {
      target.add(edge.targetHandle)
    }
  }
  return { source: [...source], target: [...target] }
}
