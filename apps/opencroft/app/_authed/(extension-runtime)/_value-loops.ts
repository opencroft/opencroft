// Edges between values never form a cycle: a value that depends on itself has
// no value, and the resolvers would stop on one wherever their pass bound fell.
// The canvas and the agents' connectNodes both refuse an edge that would close
// one, through this.
//
// Safe for both server and client — no runtime imports.

import { isValueType } from '@opencroft/core/values'

import { type WiringEdge, type WiringNode, wiredEdges } from '@/app/_authed/(extension-runtime)/_wired-edges'

/**
 * The loop of values that an edge among `added` (by stored edge id) closes,
 * as the ids of the nodes on it in order, from that edge's source round to it
 * again; null when none does. A value edge is one whose source handle carries a
 * value type, a primitive or the object (`sourceType` answers the qualified type of a node's source
 * handle). Every value output of a node is taken to depend on every value input
 * of it. Read through subgraph ports (see `wiredEdges`), so a loop that leaves
 * a subgraph and comes back in is found.
 */
export function valueLoop<E extends WiringEdge>(
  graph: { nodes: readonly WiringNode[]; edges: readonly E[] },
  added: ReadonlySet<string>,
  sourceType: (nodeId: string, handleId: string) => string | undefined,
): string[] | null {
  const valueEdges = wiredEdges(graph).filter(
    (edge) => edge.sourceHandle && isValueType(sourceType(edge.source, edge.sourceHandle)),
  )
  const next = new Map<string, string[]>()
  for (const edge of valueEdges) {
    next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target])
  }
  for (const edge of valueEdges) {
    if (!(edge.via ?? [edge.id]).some((id) => added.has(id))) {
      continue
    }
    const back = pathBetween(next, edge.target, edge.source)
    if (back) {
      return [edge.source, ...back]
    }
  }
  return null
}

// The shortest path of nodes from `from` to `to`, both included, or null.
function pathBetween(next: ReadonlyMap<string, string[]>, from: string, to: string): string[] | null {
  const cameFrom = new Map<string, string | null>([[from, null]])
  const queue = [from]
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]
    if (at === to) {
      const path: string[] = []
      for (let step: string | null = at; step !== null; step = cameFrom.get(step) ?? null) {
        path.unshift(step)
      }
      return path
    }
    for (const target of next.get(at) ?? []) {
      if (!cameFrom.has(target)) {
        cameFrom.set(target, at)
        queue.push(target)
      }
    }
  }
  return null
}

/** Why an edge closing `loop` is refused, naming each node on it by `nameOf`, in order. */
export function loopRefusal(loop: readonly string[], nameOf: (nodeId: string) => string): string {
  return `The edge would close a loop of values: ${loop.map(nameOf).join(' → ')}. A value cannot depend on itself: feed one of these inputs from outside the loop.`
}
