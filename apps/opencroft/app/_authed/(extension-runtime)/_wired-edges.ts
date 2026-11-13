// Wiring through subgraph ports. An edge is stored on the level it is drawn
// on, so a value going into a subgraph is two stored edges: one outside, into
// the subgraph's port handle, and one inside, out of the same handle (see
// `subgraph-shared.ts`). Everything that acts on wiring (contexts, streams,
// exec dispatch, connected sources, the node checks) reads it through
// `wiredEdges`, which joins each such chain into the one direct edge it stands
// for, so a node behaves the same inside a subgraph as outside one. The canvas
// and the agents' edge listing show the stored edges.
//
// The subgraphs' invariants are kept here too (`normaliseSubgraphs`), on
// every server write, beside the frame tree's.
//
// Safe for both server and client — no runtime imports.

import {
  findPort,
  isSubgraph,
  type PortSide,
  portsOf,
  portValueOf,
  type SubgraphPort,
  type SubgraphPorts,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { byIdOf, levelOf, type TreeNode } from '@/app/_authed/(extension-runtime)/_frame-tree'
import { feedingEdges } from '@/app/_authed/(extension-runtime)/_input-edges'
import { withBoundariesPlaced } from '@/app/_authed/(extension-runtime)/_subgraph-boundaries'

/** An edge as wiring reads it. */
export interface WiringEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

/** A node as wiring reads it. */
export interface WiringNode extends TreeNode {
  data?: unknown
}

/** A joined edge: the stored edges it stands for, outermost source first, are in `via`. */
export type Wired<E extends WiringEdge> = E & { via?: string[] }

interface WiringGraph<E extends WiringEdge> {
  nodes: readonly WiringNode[]
  edges: readonly E[]
}

// One result per edge list, as long as it is read with the same node list.
// Every write to a graph replaces both lists (the registry's copy is rebuilt
// from the document, the canvas's state is immutable), so a list's identity
// stands for the graph's revision and no walker computes the join on its own
// read.
const memo = new WeakMap<readonly WiringEdge[], { nodes: readonly WiringNode[]; wired: WiringEdge[] }>()

/**
 * The graph's edges with every chain through subgraph ports joined into the
 * direct edge it stands for: an outer edge `X → S/in-p` and an inner edge
 * `S/in-p → Y` give `X → Y`; an inner edge `Z → S/out-p` and an outer edge
 * `S/out-p → W` give `Z → W`. Chains through nested subgraphs, and from one
 * subgraph's output into another's input, are followed to their real ends. A
 * joined edge keeps its last stored edge's fields, takes the first one's
 * source, and lists the stored edges in `via`; its id is theirs joined with
 * `>`. A port with nothing on one side gives nothing, except an input port
 * of a value type with nothing outside and a value typed on the subgraph's
 * card (`portValueOf`): its edges inside start at the subgraph, which exposes
 * that value, so an edge outside wins over it and it wins over what the
 * inner node has typed itself. Every other edge is
 * returned as it is, and a graph without a subgraph gets its own list back.
 *
 * One pass indexes the edges on subgraph handles; each edge from a real source
 * into a port is then followed. Joined edges come in the order of the edge
 * their chain starts with.
 */
export function wiredEdges<E extends WiringEdge>(graph: WiringGraph<E>): Array<Wired<E>> {
  const cached = memo.get(graph.edges)
  if (cached && cached.nodes === graph.nodes) {
    return cached.wired as Array<Wired<E>>
  }
  const wired = joinPorts(graph)
  memo.set(graph.edges, { nodes: graph.nodes, wired })
  return wired
}

/**
 * `wiredEdges` of a graph as it is stored, its records untyped, read as the
 * edge shape `E` its caller walks: the stored records are taken to have it.
 */
export function wiredEdgesOf<E>(graph: {
  nodes: readonly Record<string, unknown>[]
  edges: readonly Record<string, unknown>[]
}): Array<E & { via?: string[] }> {
  return wiredEdges(graph as unknown as WiringGraph<WiringEdge>) as unknown as Array<E & { via?: string[] }>
}

function joinPorts<E extends WiringEdge>({ nodes, edges }: WiringGraph<E>): Array<Wired<E>> {
  const subgraphs = new Set(nodes.filter(isSubgraph).map((n) => n.id))
  if (subgraphs.size === 0 || !edges.some((e) => subgraphs.has(e.source) || subgraphs.has(e.target))) {
    return edges as Array<Wired<E>>
  }
  // The edges leaving each port, by subgraph and handle: on an input port the
  // inner ones, on an output port the outer ones.
  const leaving = new Map<string, E[]>()
  for (const edge of edges) {
    if (subgraphs.has(edge.source) && edge.sourceHandle) {
      const key = portKey(edge.source, edge.sourceHandle)
      leaving.set(key, [...(leaving.get(key) ?? []), edge])
    }
  }
  const out: Array<Wired<E>> = []
  const follow = (chain: E[]) => {
    const last = chain[chain.length - 1]
    for (const next of leaving.get(portKey(last.target, last.targetHandle ?? '')) ?? []) {
      if (chain.includes(next)) {
        continue
      }
      if (subgraphs.has(next.target)) {
        follow([...chain, next])
        continue
      }
      const via = [...chain, next].map((e) => e.id)
      out.push({
        ...next,
        id: via.join('>'),
        source: chain[0].source,
        sourceHandle: chain[0].sourceHandle,
        via,
      })
    }
  }
  // An input port of a value type with no edge outside feeds what it is wired
  // to inside with the value typed on the subgraph's card, so the chain starts
  // at the port itself: the subgraph exposes that value (see `sourceHandleOf`).
  const fed = new Set(edges.filter((e) => subgraphs.has(e.target)).map((e) => portKey(e.target, e.targetHandle ?? '')))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const startsAtPortValue = (edge: E) =>
    Boolean(edge.sourceHandle) &&
    !fed.has(portKey(edge.source, edge.sourceHandle ?? '')) &&
    portValueOf(byId.get(edge.source)?.data, edge.sourceHandle ?? '') !== undefined
  for (const edge of edges) {
    if (subgraphs.has(edge.source)) {
      if (!startsAtPortValue(edge)) {
        continue
      }
      if (subgraphs.has(edge.target)) {
        follow([edge])
      } else {
        out.push(edge)
      }
      continue
    }
    if (subgraphs.has(edge.target)) {
      follow([edge])
    } else {
      out.push(edge)
    }
  }
  return out
}

/** Where a wired input's value comes from: a node's output handle. */
export interface InputFeed {
  source: string
  sourceHandle?: string | null
}

/**
 * What feeds the input `handleId` of `nodeId`, or undefined when nothing is
 * wired into it: the source of the edge `wiredEdges` gives into it, else, on
 * a subgraph's own input port, the source of the edge wired into the port
 * from outside. `wiredEdges` joins that edge into the edges past the port, so
 * it names no edge ending on the port itself (and none at all while nothing is
 * wired past it). That source is followed back through other subgraphs' ports
 * as `wiredEdges` follows them; a chain that starts at a port nothing feeds
 * ends at that port, whose subgraph exposes the value typed on it (see
 * `sourceHandleOf`).
 */
export function inputFeedOf<E extends WiringEdge>(
  graph: WiringGraph<E>,
  nodeId: string,
  handleId: string,
): InputFeed | undefined {
  const joined = feedingEdges(wiredEdges(graph)).find((e) => e.target === nodeId && e.targetHandle === handleId)
  if (joined) {
    return { source: joined.source, sourceHandle: joined.sourceHandle }
  }
  const subgraphs = new Set(graph.nodes.filter(isSubgraph).map((n) => n.id))
  if (!subgraphs.has(nodeId)) {
    return undefined
  }
  const feeding = feedingEdges(graph.edges)
  const into = (target: string, handle: string | null | undefined) =>
    feeding.find((e) => e.target === target && e.targetHandle === handle)
  let end = into(nodeId, handleId)
  const seen = new Set<E>()
  while (end && subgraphs.has(end.source) && !seen.has(end)) {
    seen.add(end)
    const before = into(end.source, end.sourceHandle)
    if (!before) {
      break
    }
    end = before
  }
  return end ? { source: end.source, sourceHandle: end.sourceHandle } : undefined
}

function portKey(nodeId: string, handleId: string): string {
  return `${nodeId}\u0000${handleId}`
}

/**
 * Whether the end of an edge on subgraph `subgraphId` is on its inner side,
 * where its boundaries draw it: the edge's other end is drawn inside the
 * subgraph, or is the subgraph itself, an input port passed straight through
 * to an output (`in-p` to `out-q`).
 */
export function onInnerSide(byId: ReadonlyMap<string, WiringNode>, subgraphId: string, otherId: string): boolean {
  return isSubgraph(byId.get(subgraphId)) && (otherId === subgraphId || levelOf(otherId, byId) === subgraphId)
}

type EdgeEnds = Pick<WiringEdge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>

/**
 * Why an edge is not allowed by the levels it joins, or null when it is. An
 * edge stays on one level, except a port edge: from a subgraph's input handle
 * to a node inside it, or from a node inside it to an output handle. A route
 * between two levels therefore goes through ports, which the message names.
 * An edge with an end that is not a node of `nodes` is left to the caller.
 */
export function crossLevelRefusal(nodes: readonly WiringNode[], edge: EdgeEnds): string | null {
  return levelProblem(byIdOf(nodes), edge)
}

function levelProblem(byId: ReadonlyMap<string, WiringNode>, edge: EdgeEnds): string | null {
  const source = byId.get(edge.source)
  const target = byId.get(edge.target)
  if (!source || !target) {
    return null
  }
  const sourceLevel = levelOf(source.id, byId)
  const targetLevel = levelOf(target.id, byId)
  // Inside a subgraph, its own handles are the boundaries' ends.
  const sourceSide = isSubgraph(source) && targetLevel === source.id ? source.id : sourceLevel
  const targetSide = isSubgraph(target) && sourceLevel === target.id ? target.id : targetLevel
  if (sourceSide === targetSide) {
    return null
  }
  const where = (level: string | undefined) => (level ? `subgraph ${level}` : 'the top level')
  return (
    `${edge.source} is on ${where(sourceLevel)} and ${edge.target} on ${where(targetLevel)}: ` +
    'an edge stays on one level. Wire between levels through a port of the subgraph between them: ' +
    "add the port to that subgraph's data.ports (inputs or outputs) with updateNodes, then connect " +
    'the source to `<subgraph>/in-<port>` from outside and `<subgraph>/in-<port>` to the target inside ' +
    '(for an output, the target `<subgraph>/out-<port>` inside and the source `<subgraph>/out-<port>` outside).'
  )
}

/**
 * Why an edge's ends on subgraphs are not ports it can use, or null when they
 * are: a handle naming a port that exists, on the side the edge is on. Outside,
 * an input port is a target and an output port a source; inside, the reverse,
 * which an edge from the subgraph to itself is (see `onInnerSide`).
 */
export function portEndProblem(nodes: readonly WiringNode[], edge: EdgeEnds): string | null {
  return portProblem(byIdOf(nodes), edge)
}

function portProblem(byId: ReadonlyMap<string, WiringNode>, edge: EdgeEnds): string | null {
  const check = (nodeId: string, handleId: string | null | undefined, role: 'source' | 'target', other: string) => {
    const node = byId.get(nodeId)
    if (!node || !isSubgraph(node)) {
      return null
    }
    const port = handleId ? findPort(node.data, handleId) : undefined
    if (!port) {
      return `${nodeId}/${handleId ?? ''} is not a port of subgraph ${nodeId}: its handles are in-<id> and out-<id> of the ports in its data.ports`
    }
    const inside = onInnerSide(byId, nodeId, other)
    const wanted: PortSide = (role === 'target') === inside ? 'outputs' : 'inputs'
    if (port.side === wanted) {
      return null
    }
    const kind = port.side === 'inputs' ? 'an input' : 'an output'
    const where = inside ? 'inside the subgraph' : 'outside the subgraph'
    return `${nodeId}/${handleId} is ${kind} port: ${where} it is a ${role === 'source' ? 'target' : 'source'}, not a ${role}`
  }
  return (
    check(edge.source, edge.sourceHandle, 'source', edge.target) ??
    check(edge.target, edge.targetHandle, 'target', edge.source)
  )
}

// `ports` with every id taken on either side kept once: the first input with
// it, else the first output.
function uniquePorts(ports: SubgraphPorts): SubgraphPorts {
  const seen = new Set<string>()
  const keep = (p: SubgraphPort) => !seen.has(p.id) && Boolean(seen.add(p.id))
  return { inputs: ports.inputs.filter(keep), outputs: ports.outputs.filter(keep) }
}

/**
 * `graph` with its subgraphs' invariants kept: port ids unique among each
 * subgraph's ports, inputs and outputs together, as `portsProblem` requires
 * of a write (a later port with a taken id goes), every edge on a subgraph
 * naming a port that exists, on its side (`portEndProblem`; so a removed port
 * takes its edges with it), and no edge between two levels other than a port
 * edge (`crossLevelRefusal`), and each boundary given its place where it has
 * none (`withBoundariesPlaced`). Returns `graph` itself when nothing changes.
 */
export function normaliseSubgraphs<G extends { nodes: unknown[]; edges: unknown[] }>(graph: G): G {
  const nodes = graph.nodes as WiringNode[]
  let nextNodes = withBoundariesPlaced(nodes)
  for (const node of nodes) {
    if (!isSubgraph(node)) {
      continue
    }
    const ports = portsOf(node.data)
    const stored = (node.data as { ports?: Partial<Record<PortSide, unknown>> } | undefined)?.ports
    const fixed = uniquePorts(ports)
    const same = (side: PortSide) => Array.isArray(stored?.[side]) && fixed[side].length === stored[side].length
    if (same('inputs') && same('outputs')) {
      continue
    }
    nextNodes = nextNodes.map((n) =>
      n.id === node.id ? { ...n, data: { ...(n.data as Record<string, unknown>), ports: fixed } } : n,
    )
  }
  const byId = byIdOf(nextNodes)
  const edges = graph.edges as WiringEdge[]
  const nextEdges = edges.filter((e) => portProblem(byId, e) === null && levelProblem(byId, e) === null)
  if (nextNodes === nodes && nextEdges.length === edges.length) {
    return graph
  }
  return { ...graph, nodes: nextNodes, edges: nextEdges }
}
