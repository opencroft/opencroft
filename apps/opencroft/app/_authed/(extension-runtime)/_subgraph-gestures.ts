// Make subgraph and Expand subgraph: the two writes that turn nodes into a
// subgraph and a subgraph back into a Section, shared by the canvas's node
// menu and the agents' `makeSubgraph` and `expandSubgraph`, so both make the
// same graph. Each is one write, so one undo step.
//
// Making keeps every node's id and what it is wired to: each edge that crosses
// the selection becomes a port (see `subgraph-shared.ts`), and `wiredEdges`
// reads the graph after it as it read the graph before. Expanding joins each
// port's pairs into the direct edges `wiredEdges` gave and leaves the members
// where they are, inside a Section that takes the subgraph's id and place.
//
// Safe for both server and client — no runtime imports.

import { type EnumCasesOf, handleTakes, takesSeveralTypes, withEnumCases } from '@opencroft/core/values'

import { sectionBoxAround } from '@/app/_authed/(dashboard)/_canvas/wrap-in-section'
import {
  boundaryHandles,
  freePortLabel,
  isSubgraph,
  type PortSide,
  portHandleId,
  portsOf,
  type SubgraphPort,
  type SubgraphPorts,
  subgraphName,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { declaredHandlesOf } from '@/app/_authed/(extension-runtime)/_declared-handles'
import {
  absolutePositions,
  byIdOf,
  descendants,
  growToHold,
  levelOf,
  type Point,
  placedRoots,
  reparent,
  roomOf,
  type TreeNode,
} from '@/app/_authed/(extension-runtime)/_frame-tree'
import { MIN_FRAME_SIZE } from '@/app/_authed/(extension-runtime)/_frames'
import { withBoundariesPlaced } from '@/app/_authed/(extension-runtime)/_subgraph-boundaries'
import { type ExtensionHandle, findExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { onInnerSide, type WiringEdge } from '@/app/_authed/(extension-runtime)/_wired-edges'

/** A node as the gestures read and write it. */
export interface GestureNode extends TreeNode {
  data?: unknown
  zIndex?: number
}

interface Graph<N, E> {
  nodes: readonly N[]
  edges: readonly E[]
}

/** The handles a node type declares, as its extension registered them. */
export type DeclaredHandles = (type: string) => readonly ExtensionHandle[]

/**
 * The handles `nodeId` has at the end of an edge whose other end is
 * `otherEnd`: a subgraph's are its ports, on its card from outside and on its
 * boundaries from inside, and any other node's what `declaredHandlesOf` gives.
 * A handle of an enum type carries the enum's cases.
 */
export function handlesAt(
  byId: ReadonlyMap<string, GestureNode>,
  nodeId: string,
  otherEnd: string,
  declared: DeclaredHandles,
  enumCasesOf: EnumCasesOf,
): readonly ExtensionHandle[] {
  const node = byId.get(nodeId)
  if (onInnerSide(byId, nodeId, otherEnd)) {
    return withEnumCases(
      [...boundaryHandles(node?.data, 'inputs'), ...boundaryHandles(node?.data, 'outputs')],
      enumCasesOf,
    )
  }
  return node ? declaredHandlesOf(node as { type?: string; data?: unknown }, declared, enumCasesOf) : []
}

export interface MakeSubgraphOptions<N> {
  /** The new subgraph: its id, type and data (a name) as the caller makes a node; its place and ports are made here. */
  subgraph: N
  /** A fresh id, for the edges a port adds and, cut short, for each port. */
  newId: () => string
  declared: DeclaredHandles
  enumCasesOf: EnumCasesOf
  /** A frame that fits itself around its members (an autolayout section), and is not grown here. */
  fitsItself?: (frame: N) => boolean
}

export type Made<N, E> = { nodes: N[]; edges: E[]; ports: SubgraphPorts } | { refused: string }

// One port being made: the edges that cross the selection through it, and
// where its inner end is drawn, which orders the ports.
interface PortDraft<E> {
  crossing: E[]
  innerAt: Point
  inner?: ExtensionHandle
  outer?: ExtensionHandle
}

/**
 * `graph` with the nodes in `picked`, and everything inside them, moved into
 * the new subgraph `options.subgraph`. All of them must be on one level. The
 * subgraph is placed where Wrap in section would put a Section around them,
 * in the frame they shared, else on their level, and that frame grows to
 * hold it. Inside, they keep their ids, their layout and where they are drawn
 * relative to that corner, so Expand subgraph puts them back where they were.
 *
 * Each edge that crosses the selection becomes a port. One input port per
 * distinct outer source (node and handle) feeds every inner target it fed,
 * and one output port per distinct inner source feeds every outer target. An
 * inner edge keeps the id of the edge it replaces on an input, and an outer
 * edge on an output: an edge keeps its id on the end it fed. Ports are
 * ordered by where their inner end is drawn, top to bottom, then left to
 * right, and labelled with the inner handle's label.
 */
export function makeSubgraph<N extends GestureNode, E extends WiringEdge>(
  graph: Graph<N, E>,
  picked: ReadonlySet<string>,
  options: MakeSubgraphOptions<N>,
): Made<N, E> {
  const { nodes } = graph
  const byId = byIdOf(nodes)
  const missing = [...picked].filter((id) => !byId.has(id))
  if (picked.size === 0 || missing.length > 0) {
    return { refused: picked.size === 0 ? 'Nothing to make a subgraph of.' : `Nodes not found: ${missing.join(', ')}` }
  }
  const levels = new Set([...picked].map((id) => levelOf(id, byId)))
  if (levels.size > 1) {
    return {
      refused: `The nodes are on ${levels.size} levels: a subgraph is made of nodes on one level (the top level, or one subgraph's canvas).`,
    }
  }
  const [level] = levels
  const inside = new Set(picked)
  for (const id of picked) {
    for (const d of descendants(id, nodes)) {
      inside.add(d)
    }
  }
  const roots = placedRoots(nodes, inside)
  const abs = absolutePositions(nodes)
  const box = sectionBoxAround(roots.map((n) => ({ ...(abs.get(n.id) ?? { x: 0, y: 0 }), ...roomOf(n) })))
  if (!box) {
    return { refused: 'Nothing to make a subgraph of.' }
  }
  const corner = { x: box.x, y: box.y }
  const sid = options.subgraph.id
  const shared = roots.every((n) => n.parentId === roots[0].parentId) ? roots[0].parentId : level
  abs.set(sid, corner)
  const placed = reparent(options.subgraph, shared ? byId.get(shared) : undefined, abs)

  const ports = portsFor(graph, inside, abs, options)
  const subgraph = { ...placed, data: { ...(placed.data as object), ports: ports.ports } } as N
  const rootIds = new Set(roots.map((n) => n.id))
  const moved = nodes.map((n) => {
    if (!rootIds.has(n.id)) {
      return n
    }
    const { extent: _extent, ...rest } = n as N & { extent?: unknown }
    const at = abs.get(n.id) ?? corner
    return { ...rest, parentId: sid, position: { x: at.x - corner.x, y: at.y - corner.y } } as N
  })
  // Before the first node it holds, so the tree's order keeps parents first.
  const at = moved.findIndex((n) => inside.has(n.id))
  const withSubgraph = [...moved.slice(0, at), subgraph, ...moved.slice(at)]
  return {
    nodes: growToHold(withBoundariesPlaced(withSubgraph) as N[], [sid], options.fitsItself),
    edges: ports.edges,
    ports: ports.ports,
  }
}

// The types every one of `handles` takes when each takes several (see
// `handleTakes`), when two or more are left; undefined otherwise.
function acceptedByAll(handles: readonly (ExtensionHandle | undefined)[]): string[] | undefined {
  if (handles.length === 0 || !handles.every((h) => h !== undefined && takesSeveralTypes(h))) {
    return undefined
  }
  const [first] = handles as ExtensionHandle[]
  const types = (first.accepts ?? []).filter((type) => handles.every((h) => h && handleTakes(h, type)))
  return types.length > 1 ? types : undefined
}

// The ports the edges crossing `inside` make, and the edges with each crossing
// edge replaced by its two halves.
function portsFor<N extends GestureNode, E extends WiringEdge>(
  { nodes, edges }: Graph<N, E>,
  inside: ReadonlySet<string>,
  abs: ReadonlyMap<string, Point>,
  { subgraph, newId, declared, enumCasesOf }: MakeSubgraphOptions<N>,
): { ports: SubgraphPorts; edges: E[] } {
  const byId: ReadonlyMap<string, GestureNode> = byIdOf(nodes)
  const handleAt = (nodeId: string, handleId: string | null | undefined, role: 'source' | 'target', other: string) =>
    handleId ? findExtensionHandle(handlesAt(byId, nodeId, other, declared, enumCasesOf), handleId, role) : undefined
  const drafts = { inputs: new Map<string, PortDraft<E>>(), outputs: new Map<string, PortDraft<E>>() }
  const before = (p: Point, q: Point) => p.y < q.y || (p.y === q.y && p.x < q.x)
  for (const edge of edges) {
    const into = inside.has(edge.target)
    if (inside.has(edge.source) === into) {
      continue
    }
    // An input is keyed by its outer source, an output by its inner one: the source either way.
    const side = into ? 'inputs' : 'outputs'
    const key = `${edge.source}\u0000${edge.sourceHandle ?? ''}`
    const innerId = into ? edge.target : edge.source
    const innerAt = abs.get(innerId) ?? { x: 0, y: 0 }
    const inner = into
      ? handleAt(edge.target, edge.targetHandle, 'target', edge.source)
      : handleAt(edge.source, edge.sourceHandle, 'source', edge.target)
    const outer = into
      ? handleAt(edge.source, edge.sourceHandle, 'source', edge.target)
      : handleAt(edge.target, edge.targetHandle, 'target', edge.source)
    const draft = drafts[side].get(key)
    if (!draft) {
      drafts[side].set(key, { crossing: [edge], innerAt, inner, outer })
      continue
    }
    draft.crossing.push(edge)
    if (before(innerAt, draft.innerAt)) {
      Object.assign(draft, { innerAt, inner: inner ?? draft.inner })
    }
  }
  const ports: SubgraphPorts = { inputs: [], outputs: [] }
  const taken = new Set<string>()
  const portId = () => {
    let id = newId().slice(0, 8)
    while (taken.has(id)) {
      id = newId().slice(0, 8)
    }
    taken.add(id)
    return id
  }
  const replaced = new Map<string, E[]>()
  for (const side of ['inputs', 'outputs'] as const) {
    const ordered = [...drafts[side].values()].sort((p, q) => (before(p.innerAt, q.innerAt) ? -1 : 1))
    for (const draft of ordered) {
      const [first] = draft.crossing
      const id = portId()
      const handle = portHandleId(side, id)
      const innerHandle = side === 'inputs' ? first.targetHandle : first.sourceHandle
      // An input takes several edges on the card only while every handle it feeds does.
      const feeds = draft.crossing.map((e) => handleAt(e.target, e.targetHandle, 'target', e.source))
      const multiple = side === 'inputs' && feeds.every((h) => h?.multiple === true)
      // ...and takes several types when every handle it feeds does: those they all take,
      // the type of the edge crossing into it among them.
      const accepts = side === 'inputs' ? acceptedByAll(feeds) : undefined
      const outerType = draft.outer?.handleType
      const port: SubgraphPort = {
        id,
        label: freePortLabel(ports[side], draft.inner?.label || draft.inner?.id || innerHandle || id),
        // A handle no declaration names (one gone stale) leaves the type to the other end.
        handleType:
          accepts && outerType && accepts.includes(outerType)
            ? outerType
            : draft.inner?.handleType || outerType || 'unknown',
        ...(accepts ? { accepts } : {}),
        ...(multiple ? { multiple: true } : {}),
      }
      ports[side].push(port)
      // The crossing edges share their source, outside for an input and inside
      // for an output: it feeds the port through one new edge, and each
      // crossing edge leaves the port for its own target, keeping its id.
      const feed = { ...first, id: newId(), target: subgraph.id, targetHandle: handle }
      const fed = draft.crossing.map((e) => ({ ...e, source: subgraph.id, sourceHandle: handle }))
      replaced.set(first.id, [feed, ...fed])
      for (const e of draft.crossing.slice(1)) {
        replaced.set(e.id, [])
      }
    }
  }
  return { ports, edges: edges.flatMap((e) => replaced.get(e.id) ?? [e]) }
}

export interface ExpandSubgraphOptions<N> {
  /** What the subgraph becomes: a Section's type, its default data, and its layer. */
  section: { type: string; data: Record<string, unknown>; zIndex?: number }
  /** A fresh id, for a joined edge whose stored edge another join has taken. */
  newId: () => string
  /** A frame that fits itself around its members (an autolayout section), and is not grown here. */
  fitsItself?: (frame: N) => boolean
}

export type Expanded<N, E> = { nodes: N[]; edges: E[] } | { refused: string }

/**
 * `graph` with the subgraph `subgraphId` turned into a Section in place: the
 * same id, position and parent, its name as the Section's label, sized to
 * its members' box with the padding Wrap in section leaves. Its members keep
 * their parentId and their layout, moved together so the box starts at the
 * Section's corner; in a subgraph Make subgraph made it starts there already,
 * so they are drawn where they were before it was made. Each port's outer and inner edges are joined into the direct edges
 * `wiredEdges` read through them, the joined edge keeping the id of the half
 * that fed its target, and the port edges go. Subgraphs inside stay
 * subgraphs: one level is expanded. The frame the Section is in grows to
 * hold it; nodes it now covers on its canvas do not join it.
 */
export function expandSubgraph<N extends GestureNode, E extends WiringEdge>(
  graph: Graph<N, E>,
  subgraphId: string,
  { section, newId, fitsItself }: ExpandSubgraphOptions<N>,
): Expanded<N, E> {
  const subgraph = graph.nodes.find((n) => n.id === subgraphId)
  if (!subgraph || !isSubgraph(subgraph)) {
    return { refused: subgraph ? `${subgraphId} is not a subgraph.` : `Node not found: ${subgraphId}` }
  }
  const members = graph.nodes.filter((n) => n.parentId === subgraphId)
  const box = sectionBoxAround(members.map((m) => ({ ...(m.position ?? { x: 0, y: 0 }), ...roomOf(m) })))
  const shift = { x: box?.x ?? 0, y: box?.y ?? 0 }
  const width = Math.max(MIN_FRAME_SIZE.width, box?.width ?? 0)
  const height = Math.max(MIN_FRAME_SIZE.height, box?.height ?? 0)
  const {
    data,
    width: _width,
    height: _height,
    measured: _measured,
    style: _style,
    zIndex: _zIndex,
    ...kept
  } = subgraph
  const asSection = {
    ...kept,
    type: section.type,
    data: { ...section.data, label: subgraphName(data) },
    style: { width, height },
    ...(section.zIndex === undefined ? {} : { zIndex: section.zIndex }),
  } as N
  const nodes = graph.nodes.map((n) => {
    if (n.id === subgraphId) {
      return asSection
    }
    if (n.parentId !== subgraphId || (shift.x === 0 && shift.y === 0)) {
      return n
    }
    const at = n.position ?? { x: 0, y: 0 }
    return { ...n, position: { x: at.x - shift.x, y: at.y - shift.y } }
  })
  return { nodes: growToHold(nodes, [subgraphId], fitsItself), edges: joinedPorts(graph.edges, subgraph, newId) }
}

// `edges` with the port edges on `subgraph` replaced by the direct edges each
// port's pairs stand for, as `wiredEdges` joins them: an input passed straight
// through to an output gives an edge from what feeds the input to what the
// output feeds.
function joinedPorts<E extends WiringEdge>(edges: readonly E[], subgraph: GestureNode, newId: () => string): E[] {
  const sid = subgraph.id
  const on = (e: E) => e.source === sid || e.target === sid
  const used = new Set(edges.filter((e) => !on(e)).map((e) => e.id))
  // A stored edge joined into several (a multiple input port fed from several
  // sources) keeps its id on the first; the others get fresh ones.
  const keepId = (id: string) => {
    if (used.has(id)) {
      return newId()
    }
    used.add(id)
    return id
  }
  const join = (side: PortSide, port: SubgraphPort, extraFeeding: readonly E[]) => {
    const handle = portHandleId(side, port.id)
    const feeding = [
      ...edges.filter((e) => e.target === sid && e.targetHandle === handle && e.source !== sid),
      ...extraFeeding,
    ]
    const leaving = edges.filter((e) => e.source === sid && e.sourceHandle === handle)
    return feeding.flatMap((from) =>
      leaving.map((to) => ({ ...to, id: keepId(to.id), source: from.source, sourceHandle: from.sourceHandle })),
    )
  }
  const { inputs, outputs } = portsOf(subgraph.data)
  // An input passed straight through to an output joins into an edge still on
  // the subgraph's output handle, which then feeds that output as an inner edge does.
  const fromInputs = inputs.flatMap((port) => join('inputs', port, []))
  const passedThrough = fromInputs.filter(on)
  const fromOutputs = outputs.flatMap((port) =>
    join(
      'outputs',
      port,
      passedThrough.filter((e) => e.targetHandle === portHandleId('outputs', port.id)),
    ),
  )
  // Two routes can join into one edge: a pass-through beside a direct edge
  // from the same output to the same input, or two passed-through inputs fed
  // from the same output. The graph keeps it once, the edge already there first.
  const kept = edges.filter((e) => !on(e))
  const seen = new Set(kept.map(endsKey))
  const joined = [...fromInputs.filter((e) => !on(e)), ...fromOutputs].filter((e) => {
    const key = endsKey(e)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
  return [...kept, ...joined]
}

/** What an edge joins: two edges with the same key are the same connection. */
function endsKey(e: WiringEdge): string {
  return JSON.stringify([e.source, e.sourceHandle ?? null, e.target, e.targetHandle ?? null])
}
