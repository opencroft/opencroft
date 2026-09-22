// Which ids a paste keeps. A pasted node or edge keeps the id it was cut or
// copied with, so whatever already refers to it -- a Terminal Router route, an
// edge, an event source -- still does after a cut-and-paste. Only an id that
// is already taken gets a new one, and then every reference to it INSIDE the
// pasted set is rewritten to match, so the set lands consistent with itself.
// References from outside the set keep pointing at the id they named, which
// after a copy is still the original.
//
// Pure, so the rule is testable without a canvas or a clipboard.

interface IdItem {
  id: string
}

interface PastedNode extends IdItem {
  parentId?: string
  data?: Record<string, unknown>
}

interface PastedEdge extends IdItem {
  source: string
  target: string
}

export function assignPasteIds<N extends PastedNode, E extends PastedEdge>(
  nodes: N[],
  edges: E[],
  taken: ReadonlySet<string>,
  mint: () => string,
): { nodes: N[]; edges: E[]; renamed: Map<string, string> } {
  // `renamed` maps an id taken OUTSIDE the paste to its replacement, which is
  // what references are rewritten by. A repeat INSIDE the payload also gets a
  // fresh id, per item, but is not a rename: references cannot tell which of
  // the two they meant, so they stay with the first.
  const renamed = new Map<string, string>()
  const used = new Set<string>()
  const claim = (id: string): string => {
    if (taken.has(id) && !renamed.has(id)) {
      const next = mint()
      renamed.set(id, next)
      used.add(next)
      return next
    }
    const candidate = renamed.get(id) ?? id
    if (used.has(candidate)) {
      const next = mint()
      used.add(next)
      return next
    }
    used.add(candidate)
    return candidate
  }
  const nodeIds = nodes.map((node) => claim(node.id))
  const pastedIds = new Set(nodes.map((node) => node.id))
  // An edge comes along only when both of its ends do.
  const keptEdges = edges.filter((edge) => pastedIds.has(edge.source) && pastedIds.has(edge.target))
  const edgeIds = keptEdges.map((edge) => claim(edge.id))

  const map = (id: string) => renamed.get(id) ?? id
  return {
    nodes: nodes.map((node, i) => ({
      ...node,
      id: nodeIds[i],
      ...(node.parentId ? { parentId: map(node.parentId) } : {}),
      ...(node.data && renamed.size > 0 ? { data: rewriteRefs(node.data, renamed) } : {}),
    })),
    edges: keptEdges.map((edge, i) => ({
      ...edge,
      id: edgeIds[i],
      source: map(edge.source),
      target: map(edge.target),
    })),
    renamed,
  }
}

// Node data refers to other nodes by plain id (`sourceNodeId`) or by a
// "node-id/handle-id" target (a router route, a terminal picker). Both forms
// are rewritten wherever they sit in the data; ids are UUIDs, so an exact
// match -- or an exact match up to the slash -- cannot be anything else.
function rewriteRefs<T>(value: T, renamed: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') {
    const slash = value.indexOf('/')
    const head = slash === -1 ? value : value.slice(0, slash)
    const next = renamed.get(head)
    return (next === undefined ? value : next + value.slice(head.length)) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteRefs(item, renamed)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, rewriteRefs(item, renamed)]),
    ) as T
  }
  return value
}
