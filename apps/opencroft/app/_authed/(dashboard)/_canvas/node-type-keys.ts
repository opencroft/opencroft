// Which node types the canvas must be able to render, and a stable key for that
// set.
//
// The flow library looks each node's `type` up in its `nodeTypes` map. A type it
// cannot find is silently replaced by the library's own default node and logged,
// once per node. So the map has to cover every type present in the GRAPH — on a
// cold load the graph arrives first and the extensions follow, and a node whose
// extension has not registered still has to be drawn.
//
// The types in the graph are ALL it has to cover. An entry does not name a
// component; it names a wrapper that looks the component up during render. So
// an entry does not need rebuilding when its extension registers — it simply
// starts resolving — and a registered type with no node on the canvas is never
// looked up at all.

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
