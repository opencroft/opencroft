// The canvas's levels: which nodes and edges React Flow is handed when a
// subgraph's canvas is open, and the way back from what it hands out to what
// the graph stores. Pure, so the canvas and its tests share it.
//
// Every node of the graph stays in React Flow, so `useNodes()` stays whole and
// any node can be looked up; the nodes off the open level carry `hidden`. The
// open subgraph's own members are handed over without their `parentId`: their
// positions are on its canvas already, so React Flow's plane is that canvas.
//
// Inside a subgraph, its ports are drawn on two boundary nodes, Inputs and
// Outputs, which the graph never stores (it keeps only where they stand; see
// `_subgraph-boundaries.ts`). Each subgraph has both, hidden unless it is
// open, and the edges between a subgraph and its own members are drawn to
// them. A boundary ends in an empty slot: an edge connected to it makes a new
// port.

import {
  type EnumCasesOf,
  handleTakes,
  inputTypeOf,
  isEnumHandle,
  type PrimitiveValue,
  type ValueOption,
  withEnumCases,
} from '@opencroft/core/values'
import type { Connection, Edge, Node } from '@xyflow/react'

import {
  boundaryHandles,
  findPort,
  freePortLabel,
  isSubgraph,
  type PortSide,
  portHandleId,
  portsOf,
  type SubgraphData,
  type SubgraphPort,
  subgraphName,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { declaredHandlesOf } from '@/app/_authed/(extension-runtime)/_declared-handles'
import { byIdOf, levelOf, type TreeNode } from '@/app/_authed/(extension-runtime)/_frame-tree'
import { takesEdge } from '@/app/_authed/(extension-runtime)/_input-types'
import { boundaryAt } from '@/app/_authed/(extension-runtime)/_subgraph-boundaries'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { onInnerSide } from '@/app/_authed/(extension-runtime)/_wired-edges'

/** The node types of the two boundaries, drawn by the canvas alone. */
export const INPUTS_BOUNDARY_TYPE = 'subgraph-inputs'
export const OUTPUTS_BOUNDARY_TYPE = 'subgraph-outputs'

/** The handle id of a boundary's empty slot, where connecting an edge makes a port. */
export const NEW_PORT_HANDLE = 'new-port'

export function boundaryId(subgraphId: string, side: PortSide): string {
  return `${subgraphId}::${side}`
}

/** The subgraph and side a boundary node id stands for, or null for any other node. */
export function boundaryOf(nodeId: string): { subgraphId: string; side: PortSide } | null {
  const at = nodeId.lastIndexOf('::')
  const side = nodeId.slice(at + 2)
  if (at <= 0 || (side !== 'inputs' && side !== 'outputs')) {
    return null
  }
  return { subgraphId: nodeId.slice(0, at), side }
}

/** What a boundary node carries: its subgraph and side. */
export interface BoundaryData extends Record<string, unknown> {
  subgraphId: string
  side: PortSide
  ports: SubgraphPort[]
}

/**
 * The nodes React Flow is handed with `level` open (a subgraph's id, or
 * undefined for the top level): every node of the graph, those off the level
 * hidden and the open subgraph's members without their parent, then each
 * subgraph's two boundaries, shown only on its own canvas. `sizes` holds the
 * boundaries' measured sizes, which only the canvas knows.
 */
export function nodesOnLevel(
  nodes: readonly Node[],
  level: string | undefined,
  sizes: ReadonlyMap<string, { width: number; height: number }>,
): Node[] {
  const byId = byIdOf(nodes)
  const out: Node[] = nodes.map((n) => {
    const hidden = levelOf(n.id, byId) !== level
    if (level && n.parentId === level) {
      const { parentId: _parentId, extent: _extent, ...rest } = n
      return { ...rest, hidden }
    }
    return hidden === Boolean(n.hidden) ? n : { ...n, hidden }
  })
  for (const subgraph of nodes) {
    if (!isSubgraph(subgraph)) {
      continue
    }
    for (const side of ['inputs', 'outputs'] as const) {
      const id = boundaryId(subgraph.id, side)
      const measured = sizes.get(id)
      out.push({
        id,
        type: side === 'inputs' ? INPUTS_BOUNDARY_TYPE : OUTPUTS_BOUNDARY_TYPE,
        position: boundaryAt(subgraph, side, nodes),
        data: { subgraphId: subgraph.id, side, ports: portsOf(subgraph.data)[side] } satisfies BoundaryData,
        hidden: subgraph.id !== level,
        deletable: false,
        selectable: false,
        ...(measured ? { measured } : {}),
      })
    }
  }
  return out
}

/**
 * The edges React Flow is handed: as stored, except that an end on a
 * subgraph's inner side (`onInnerSide`: an edge between the subgraph and one
 * of its own members, or an input passed straight through to an output) is
 * drawn to the boundary of its side. Ids are kept, so a change React Flow
 * reports applies to the stored edge.
 */
export function edgesOnCanvas(edges: readonly Edge[], nodes: readonly Node[]): Edge[] {
  const byId = byIdOf(nodes)
  return edges.map((e) => {
    const source = onInnerSide(byId, e.source, e.target) ? boundaryId(e.source, 'inputs') : e.source
    const target = onInnerSide(byId, e.target, e.source) ? boundaryId(e.target, 'outputs') : e.target
    return source === e.source && target === e.target ? e : { ...e, source, target }
  })
}

/** `conn`, drawn between canvas nodes, between the nodes the graph stores: a boundary end is its subgraph. */
export function storedConnection<C extends Pick<Connection, 'source' | 'target'>>(conn: C): C {
  return {
    ...conn,
    source: boundaryOf(conn.source)?.subgraphId ?? conn.source,
    target: boundaryOf(conn.target)?.subgraphId ?? conn.target,
  }
}

/**
 * The handles a canvas node has: a boundary's are its side's ports and its
 * empty slot, and any other node's what `declaredHandlesOf` gives (a
 * subgraph's ports, a value node's from its data, else what its type declares
 * in `declared`). The slot carries no handle type: what it connects to gives
 * the new port its type.
 */
export function canvasHandles(
  node: Node | undefined,
  nodes: readonly Node[],
  declared: (type: string) => ExtensionHandle[],
  enumCasesOf: EnumCasesOf,
): ExtensionHandle[] {
  if (!node) {
    return []
  }
  const boundary = boundaryOf(node.id)
  if (boundary) {
    const subgraph = nodes.find((n) => n.id === boundary.subgraphId)
    const slot: ExtensionHandle = {
      id: NEW_PORT_HANDLE,
      handleType: '',
      role: boundary.side === 'inputs' ? 'source' : 'target',
      label: 'New port',
    }
    return [...withEnumCases(boundaryHandles(subgraph?.data, boundary.side), enumCasesOf), slot]
  }
  return declaredHandlesOf(node, declared, enumCasesOf)
}

/**
 * Whether an edge from `source` to `target` passes an input port straight
 * through to an output: from a port on a subgraph's Inputs to its Outputs.
 */
export function passesThrough(
  source: { nodeId: string; handle: ExtensionHandle },
  target: { nodeId: string },
): boolean {
  const from = boundaryOf(source.nodeId)
  const to = boundaryOf(target.nodeId)
  return (
    from?.side === 'inputs' &&
    to?.side === 'outputs' &&
    from.subgraphId === to.subgraphId &&
    source.handle.id !== NEW_PORT_HANDLE
  )
}

/**
 * Whether two handles may be joined by an edge: one of them a boundary's
 * empty slot and the other a node's own handle, or a port on Inputs into the
 * slot of Outputs (`passesThrough`), whose type the new port takes; else when
 * the target takes the source's type (see `handleTakes`: the same type, or a
 * number or a boolean into a text input, and for an input that takes several
 * types exactly those, the one its group has now while another of the group
 * is wired by `edges`). An input port that takes several types (its handle on
 * Inputs carries `accepts`) connects inside when the target takes any of
 * them, and is narrowed to those on connect (see `narrowedInput`).
 */
export function handlesConnect(
  source: { nodeId: string; handle: ExtensionHandle },
  target: { nodeId: string; handle: ExtensionHandle; handles?: readonly ExtensionHandle[] },
  edges: readonly Pick<Edge, 'target' | 'targetHandle'>[] = [],
): boolean {
  const slot = (end: { nodeId: string; handle: ExtensionHandle }) =>
    end.handle.id === NEW_PORT_HANDLE && boundaryOf(end.nodeId) !== null
  if (slot(source) || slot(target)) {
    const other = slot(source) ? target : source
    return boundaryOf(other.nodeId) === null || passesThrough(source, target)
  }
  const handles = target.handles ?? [target.handle]
  const types = source.handle.accepts?.length ? source.handle.accepts : [source.handle.handleType]
  const isEnum = isEnumHandle(source.handle)
  return types.some((type) => takesEdge(target.nodeId, handles, target.handle, type, edges, isEnum))
}

/**
 * The port an edge connected to a boundary's empty slot makes, with the
 * handle it was connected to inside (`inner`): the type that handle has now,
 * its label (numbered when taken), and for an input, the types that handle
 * takes when it takes several (`accepts`, `acceptsEnums`; never its
 * `typeGroup`, which is its node's), `multiple` when that handle takes
 * several edges, and the value that handle reads now (`innerValue`, what is
 * typed into it or its default), which the input port starts with typed on
 * the card. An input port given `choices` (a text Switch's cases, see
 * `choicesFeeding`) takes only those, and starts with the inner value only
 * when it is one of them. Returns the subgraph's data with the port added,
 * and the port's handle id.
 */
export function addPort(
  data: unknown,
  side: PortSide,
  inner: ExtensionHandle,
  newId: string,
  innerValue?: PrimitiveValue,
  choices?: readonly ValueOption[],
): { data: SubgraphData; handleId: string } {
  const ports = portsOf(data)
  const chosen = side === 'inputs' && choices && choices.length > 0 ? [...choices] : undefined
  const port: SubgraphPort = {
    id: newId,
    label: freePortLabel(ports[side], inner.label || inner.id),
    handleType: inner.handleType,
    ...(side === 'inputs' && inner.accepts?.length ? { accepts: [...inner.accepts] } : {}),
    ...(side === 'inputs' && inner.acceptsEnums ? { acceptsEnums: true } : {}),
    ...(side === 'inputs' && inner.multiple ? { multiple: true } : {}),
    ...(chosen ? { options: chosen } : {}),
  }
  const handleId = portHandleId(side, newId)
  const next: SubgraphData = { ...(data as SubgraphData), ports: { ...ports, [side]: [...ports[side], port] } }
  const keepsValue = !chosen || chosen.some((c) => c.value === innerValue)
  if (side === 'inputs' && innerValue !== undefined && keepsValue) {
    const typed = (data as { inputs?: unknown } | undefined)?.inputs
    const inputs = typed !== null && typeof typed === 'object' && !Array.isArray(typed) ? typed : {}
    Object.assign(next, { inputs: { ...inputs, [handleId]: innerValue } })
  }
  return { data: next, handleId }
}

/**
 * An edge drawn to a boundary's empty slot, as the graph stores it: its
 * subgraph's data with the port the edge makes (see `addPort`, which reads
 * `inner`, `innerValue` and `choices`), and the edge on that port's handle in
 * place of the slot. Null when neither end is a slot. Passed straight through
 * from an input port to Outputs' slot, the edge leaves that input port as it
 * is: one that takes several edges on the card keeps taking them, each of
 * them reaching what the new output feeds.
 */
export function slotConnection<C extends Connection>(
  conn: C,
  data: unknown,
  inner: ExtensionHandle,
  newId: string,
  { innerValue, choices }: { innerValue?: PrimitiveValue; choices?: readonly ValueOption[] } = {},
): { side: PortSide; data: SubgraphData; stored: C } | null {
  const slot =
    (conn.sourceHandle === NEW_PORT_HANDLE && boundaryOf(conn.source)) ||
    (conn.targetHandle === NEW_PORT_HANDLE && boundaryOf(conn.target)) ||
    null
  if (!slot) {
    return null
  }
  const made = addPort(data, slot.side, inner, newId, innerValue, choices)
  const stored = storedConnection(conn)
  return {
    side: slot.side,
    data: made.data,
    stored:
      slot.side === 'inputs' ? { ...stored, sourceHandle: made.handleId } : { ...stored, targetHandle: made.handleId },
  }
}

/**
 * The subgraph's data after its input port `handleId` was connected inside to
 * `inner`: an input port takes several edges on the card only while every
 * handle it feeds inside does, so one that takes a single edge clears it;
 * and a port that takes several types takes only those every handle it
 * feeds takes (`handleTakes`), its type now among them when it still is one,
 * and one type when one is left. Returns `data` itself when nothing changes.
 */
export function narrowedInput(data: unknown, handleId: string, inner: ExtensionHandle): unknown {
  const ports = portsOf(data)
  const port = ports.inputs.find((p) => portHandleId('inputs', p.id) === handleId)
  if (!port) {
    return data
  }
  let narrowed: SubgraphPort = port
  if (port.multiple && !inner.multiple) {
    const { multiple: _multiple, ...single } = narrowed
    narrowed = single
  }
  const accepts = port.accepts?.filter((type) => handleTakes(inner, type))
  if (accepts && accepts.length > 0 && accepts.length < (port.accepts?.length ?? 0)) {
    const { accepts: _accepts, ...rest } = narrowed
    const now = inputTypeOf(data as Record<string, unknown> | undefined, { ...port, id: handleId })
    const handleType = accepts.includes(now) ? now : accepts[0]
    narrowed = accepts.length > 1 ? { ...rest, handleType, accepts } : { ...rest, handleType }
  }
  if (narrowed === port) {
    return data
  }
  return {
    ...(data as SubgraphData),
    ports: { ...ports, inputs: ports.inputs.map((p) => (p === port ? narrowed : p)) },
  }
}

/**
 * `edges` without those on a port of `subgraphId` that its `data` does not
 * hold: a port removed takes its edges on both sides with it, in the same
 * write. Returns `edges` itself when none goes.
 */
export function edgesKeptByPorts<E extends Pick<Edge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>>(
  edges: E[],
  subgraphId: string,
  data: unknown,
): E[] {
  const gone = (nodeId: string, handleId: string | null | undefined) =>
    nodeId === subgraphId && !findPort(data, handleId ?? '')
  const kept = edges.filter((e) => !gone(e.source, e.sourceHandle) && !gone(e.target, e.targetHandle))
  return kept.length === edges.length ? edges : kept
}

// A graph as the document holds it: its records are read as nodes and edges.
interface LevelGraph {
  nodes: readonly object[]
  edges: readonly object[]
}

type LevelEdge = Pick<Edge, 'id' | 'source' | 'target'>

/**
 * The levels a change from `before` to `after` is seen on, in the graph's
 * order: where each node it added, removed or changed is drawn (a removed
 * node where it was), a subgraph whose ports changed inside it as well, as
 * its Inputs and Outputs draw them, and each edge, an edge on a subgraph's inner side
 * (`onInnerSide`) being drawn inside it. Undo and redo open one of them when the
 * canvas shows none, so what they did is in view. `undefined` stands for the
 * top level.
 */
export function levelsChanged(before: LevelGraph, after: LevelGraph): Array<string | undefined> {
  const was = byIdOf(before.nodes as readonly TreeNode[])
  const now = byIdOf(after.nodes as readonly TreeNode[])
  const levels: Array<string | undefined> = []
  const add = (level: string | undefined) => {
    if (!levels.includes(level)) {
      levels.push(level)
    }
  }
  const drawnOn = (nodeId: string) => (now.has(nodeId) ? levelOf(nodeId, now) : levelOf(nodeId, was))
  // A subgraph's ports are drawn inside it too, on its Inputs and Outputs.
  const portsChanged = (nodeId: string) => {
    const before = was.get(nodeId) as (TreeNode & { data?: unknown }) | undefined
    const after = now.get(nodeId) as (TreeNode & { data?: unknown }) | undefined
    return (
      isSubgraph(before) &&
      isSubgraph(after) &&
      JSON.stringify(portsOf(before?.data)) !== JSON.stringify(portsOf(after?.data))
    )
  }
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    if (JSON.stringify(was.get(id)) !== JSON.stringify(now.get(id))) {
      add(drawnOn(id))
      if (portsChanged(id)) {
        add(id)
      }
    }
  }
  const edgesWere = new Map((before.edges as readonly LevelEdge[]).map((e) => [e.id, e]))
  const edgesNow = new Map((after.edges as readonly LevelEdge[]).map((e) => [e.id, e]))
  for (const id of new Set([...edgesWere.keys(), ...edgesNow.keys()])) {
    const edge = edgesNow.get(id) ?? edgesWere.get(id)
    if (!edge || JSON.stringify(edgesWere.get(id)) === JSON.stringify(edgesNow.get(id))) {
      continue
    }
    const nodes = edgesNow.has(id) ? now : was
    add(
      onInnerSide(nodes, edge.source, edge.target)
        ? edge.source
        : onInnerSide(nodes, edge.target, edge.source)
          ? edge.target
          : levelOf(edge.source, nodes),
    )
  }
  return levels
}

/**
 * The open level's path: the graph's name, then each subgraph from the
 * outermost to `level`, by name. `rootId` stands for the top level.
 */
export function levelPath(
  nodes: readonly Node[],
  level: string | undefined,
  graphName: string,
  rootId: string,
): Array<{ id: string; label: string }> {
  const chain = subgraphChain(level, byIdOf(nodes))
  return [{ id: rootId, label: graphName }, ...chain.map((s) => ({ id: s.id, label: subgraphName(s.data) }))]
}

/**
 * Where a level is, for a list of nodes from every level (Find): the names of
 * the subgraphs from the outermost to `level`, or `graphName` for the top level.
 */
export function levelName<N extends TreeNode & { data?: unknown }>(
  level: string | undefined,
  byId: ReadonlyMap<string, N>,
  graphName: string,
): string {
  const chain = subgraphChain(level, byId)
  return chain.length > 0 ? chain.map((s) => subgraphName(s.data)).join(' / ') : graphName
}

// The subgraphs from the outermost to `level`; none for the top level.
function subgraphChain<N extends TreeNode>(level: string | undefined, byId: ReadonlyMap<string, N>): N[] {
  const chain: N[] = []
  let at = level ? byId.get(level) : undefined
  const seen = new Set<string>()
  while (at && !seen.has(at.id)) {
    seen.add(at.id)
    chain.unshift(at)
    const outer = levelOf(at.id, byId)
    at = outer ? byId.get(outer) : undefined
  }
  return chain
}
