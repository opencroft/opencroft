// Which node types the canvas must be able to render, and a stable key for that
// set.
//
// The flow library looks each node's `type` up in its `nodeTypes` map. A type it
// cannot find is silently replaced by the library's own default node and logged,
// once per node. So the map has to cover every type present in the GRAPH, not
// only the types an extension has registered — on a cold load the graph arrives
// first and the extensions follow.

/** The sorted, de-duplicated node types present in a graph. */
export function graphNodeTypes(nodes: readonly { type?: string }[]): string[] {
  const seen = new Set<string>()
  for (const node of nodes) {
    if (node.type) {
      seen.add(node.type)
    }
  }
  return [...seen].sort()
}

/**
 * A value that changes only when the SET of types changes.
 *
 * Sorted and de-duplicated before encoding, so the key answers "which types are
 * on the canvas" rather than "in what order were they found" — nodes are
 * reordered by selection, dragging and resyncs far more often than a type
 * appears or disappears, and staying still through all of that is the point.
 *
 * Encoded as JSON rather than joined on a separator. Any separator character
 * can in principle occur inside a node type, and when it does two different
 * sets collapse to the same key — the canvas would then be missing a component
 * for a type it really contains, which is the exact failure this key exists to
 * prevent. JSON is unambiguous for every input, and needs no reasoning about
 * which characters are safe.
 */
export function nodeTypesKey(types: readonly string[]): string {
  return JSON.stringify(types)
}

export function typesFromKey(key: string): string[] {
  return key ? (JSON.parse(key) as string[]) : []
}

/**
 * Every node type the canvas needs a component for: the ones extensions have
 * registered, plus the ones the graph actually contains.
 *
 * The second half is the part that is easy to leave out. A type only the graph
 * knows about is one whose extension has not registered — either not yet, or
 * never — and those are exactly the nodes that need drawing as loading or as
 * missing. Without an entry they never reach our component at all.
 *
 * Kept here, apart from the components, so it can be exercised directly: the
 * module that builds the components pulls in a stylesheet, which a plain test
 * runner cannot load.
 */
export function nodeTypeIds(registered: readonly string[], graphTypes: readonly string[]): string[] {
  const ids = new Set<string>(registered)
  for (const type of graphTypes) {
    ids.add(type)
  }
  return [...ids]
}
