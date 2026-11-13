// Inputs that take several types (`accepts`, see `AcceptedTypes` in
// `@opencroft/core/values`). Their type is the one connected into them,
// stored on the node at `data.inputTypes.<group>`:
// - connecting writes it, in the same write as the edge (`dataOnConnect`), on
//   the canvas and in connectNodes alike, which refuse by the same rule
//   (`connectRefusal`);
// - `withFollowedTypes` keeps it in step with what feeds the input, so a
//   change of type upstream flows down. It runs before contexts are resolved.
// Removing the edge keeps the type.
//
// Safe for both server and client — no runtime imports.

import {
  acceptedTypesPhrase,
  type EnumCasesOf,
  handleTakes,
  isValueType,
  takesSeveralTypes,
  typeGroupOf,
  withInputType,
} from '@opencroft/core/values'

import {
  boundaryHandles,
  isSubgraph,
  portOfHandle,
  portsOf,
  type SubgraphData,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { declaredHandlesOf } from '@/app/_authed/(extension-runtime)/_declared-handles'
import { feedingEdges } from '@/app/_authed/(extension-runtime)/_input-edges'
import { type ExtensionHandle, findExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { type WiringEdge, wiredEdges } from '@/app/_authed/(extension-runtime)/_wired-edges'

interface InputEdge {
  target: string
  targetHandle?: string | null
}

/**
 * The input of `nodeId` already wired by `edges` that fixes the type of
 * `handle`'s type group: another input of the group, or `handle` itself when
 * it takes several edges. Undefined for an input that takes one type, or
 * while nothing else of its group is wired; an edge into `handle` itself is
 * replaced by a new one.
 */
export function wiredInGroup(
  nodeId: string,
  handles: readonly ExtensionHandle[],
  handle: ExtensionHandle,
  edges: readonly InputEdge[],
): ExtensionHandle | undefined {
  if (!takesSeveralTypes(handle)) {
    return undefined
  }
  const group = typeGroupOf(handle)
  const fixing = handles.filter(
    (h) =>
      h.role === 'target' &&
      takesSeveralTypes(h) &&
      typeGroupOf(h) === group &&
      (h.id !== handle.id || handle.multiple === true),
  )
  return fixing.find((h) => edges.some((e) => e.target === nodeId && e.targetHandle === h.id))
}

/**
 * Whether the target `handle` of `nodeId` takes an edge from a source of
 * `sourceType`, with `edges` into the node as they stand (see `handleTakes`
 * and `wiredInGroup`). `isEnum`: the source's type is an enum (its handle
 * carries `cases`).
 */
export function takesEdge(
  nodeId: string,
  handles: readonly ExtensionHandle[],
  handle: ExtensionHandle,
  sourceType: string,
  edges: readonly InputEdge[],
  isEnum = false,
): boolean {
  const groupWired = wiredInGroup(nodeId, handles, handle, edges) !== undefined
  return handleTakes(handle, sourceType, { isEnum, groupWired })
}

/**
 * Why the target `handle` of `nodeId` refuses an edge from a source of
 * `sourceType`, naming what it takes, or null when it takes it (see
 * `handleTakes`). `edges` are the edges into the node as they stand.
 * `subject` names the input in the sentence; `isEnum` as for `takesEdge`.
 */
export function connectRefusal(
  nodeId: string,
  handles: readonly ExtensionHandle[],
  handle: ExtensionHandle,
  sourceType: string,
  edges: readonly InputEdge[],
  { subject = handle.label ?? handle.id, isEnum = false }: { subject?: string; isEnum?: boolean } = {},
): string | null {
  if (takesEdge(nodeId, handles, handle, sourceType, edges, isEnum)) {
    return null
  }
  const fixedBy = wiredInGroup(nodeId, handles, handle, edges)
  if (fixedBy) {
    const by = fixedBy.id === handle.id ? 'it' : (fixedBy.label ?? fixedBy.id)
    return `${subject} shares one type with the inputs of its group, and ${by} is wired from ${handle.handleType}: it takes ${handle.handleType} only, not ${sourceType}.`
  }
  if (takesSeveralTypes(handle)) {
    const listed = [...(handle.accepts ?? []), ...(handle.acceptsEnums ? ['every enum'] : [])]
    return `${subject} takes ${acceptedTypesPhrase(handle)} (${listed.join(', ')}), not ${sourceType}.`
  }
  return null
}

/**
 * The data of a node after an edge from a source of `sourceType` is
 * connected into its input `handle`: for an input that takes several types,
 * its group's type set to the source's; `data` itself otherwise. `isEnum` as
 * for `takesEdge`.
 */
export function dataOnConnect<D extends Readonly<Record<string, unknown>>>(
  data: D,
  handle: ExtensionHandle | undefined,
  sourceType: string | undefined,
  isEnum = false,
): D {
  if (!handle || !sourceType || !takesSeveralTypes(handle) || !handleTakes(handle, sourceType, { isEnum })) {
    return data
  }
  return withInputType(data, typeGroupOf(handle), sourceType) as D
}

interface FollowNode {
  id: string
  type?: string
  data?: Record<string, unknown>
  parentId?: string
}

interface FollowGraph<N extends FollowNode, E extends WiringEdge> {
  nodes: readonly N[]
  edges: readonly E[]
}

/**
 * `graph` with the type of every several-type input's group set to the type
 * of what feeds it now, when all the group's wired inputs are fed that one
 * type and the group accepts it. A group fed two types, or a type it does not
 * take, keeps its type, and its node's check names the input that is off.
 * Every output port of a value type takes the type of the inner source
 * feeding it the same way. A subgraph's input port fed from outside follows
 * as `data.inputTypes.in-<port>` on the subgraph.
 *
 * Inputs are read through subgraph ports (`wiredEdges`), so an inner node
 * follows what is wired outside. A type set here can change the type of an
 * output downstream (Select's Value), so the walk repeats until nothing
 * changes. A group's type depends only on the types of its sources, and value
 * edges make no loop, so it ends within one pass per edge.
 * Returns `graph` itself when nothing changes.
 */
export function withFollowedTypes<N extends FollowNode, E extends WiringEdge, G extends FollowGraph<N, E>>(
  graph: G,
  handlesOfType: (type: string) => readonly ExtensionHandle[],
  enumCasesOf: EnumCasesOf,
): G {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  // The edges into real nodes, joined through ports, and the stored edges onto
  // a subgraph's own ports: from outside into an input, from inside into an output.
  const edges = [
    ...feedingEdges(wiredEdges(graph)).filter((e) => !isSubgraph(byId.get(e.target))),
    ...feedingEdges(graph.edges).filter((e) => isSubgraph(byId.get(e.target))),
  ]
  if (edges.length === 0) {
    return graph
  }
  const sourceType = (edge: WiringEdge) => {
    const node = byId.get(edge.source)
    if (!node || !edge.sourceHandle) {
      return undefined
    }
    const own = declaredHandlesOf(node, handlesOfType, enumCasesOf)
    const handles = isSubgraph(node) ? [...own, ...boundaryHandles(node.data, 'inputs')] : own
    return findExtensionHandle(handles, edge.sourceHandle, 'source')?.handleType
  }
  let changed = false
  for (let pass = 0; pass <= edges.length; pass++) {
    let changedThisPass = false
    for (const slot of followSlots(edges, byId, sourceType, handlesOfType, enumCasesOf)) {
      const target = byId.get(slot.nodeId)
      const [type, ...others] = slot.types
      if (!target || !type || others.length > 0) {
        continue
      }
      const data = followedData(target, slot, type, enumCasesOf)
      if (data !== target.data) {
        byId.set(target.id, { ...target, data })
        changedThisPass = true
      }
    }
    if (!changedThisPass) {
      break
    }
    changed = true
  }
  return changed ? { ...graph, nodes: graph.nodes.map((n) => byId.get(n.id) ?? n) } : graph
}

// What follows the types fed into it: the type group of a node's several-type
// inputs, or an output port of a subgraph.
type FollowSlot = { nodeId: string; types: Set<string> } & (
  | { handle: ExtensionHandle; portId?: undefined }
  | { handle?: undefined; portId: string }
)

// The slots `edges` feed, each with the types of all its sources.
function followSlots(
  edges: readonly (WiringEdge & { targetHandle: string })[],
  byId: ReadonlyMap<string, FollowNode>,
  sourceType: (edge: WiringEdge) => string | undefined,
  handlesOfType: (type: string) => readonly ExtensionHandle[],
  enumCasesOf: EnumCasesOf,
): Iterable<FollowSlot> {
  const slots = new Map<string, FollowSlot>()
  const handlesOf = new Map<string, readonly ExtensionHandle[]>()
  for (const edge of edges) {
    const target = byId.get(edge.target)
    const type = sourceType(edge)
    if (!target || !type) {
      continue
    }
    const port = isSubgraph(target) ? portOfHandle(edge.targetHandle) : null
    let slot: FollowSlot
    if (port?.side === 'outputs') {
      slot = { nodeId: target.id, portId: port.portId, types: new Set() }
    } else {
      const handles = handlesOf.get(target.id) ?? declaredHandlesOf(target, handlesOfType, enumCasesOf)
      handlesOf.set(target.id, handles)
      const handle = findExtensionHandle(handles, edge.targetHandle, 'target')
      if (!handle || !takesSeveralTypes(handle)) {
        continue
      }
      slot = { nodeId: target.id, handle, types: new Set() }
    }
    const key = `${target.id}\u{0}${slot.handle ? `group:${typeGroupOf(slot.handle)}` : `port:${slot.portId}`}`
    const found = slots.get(key) ?? slot
    found.types.add(type)
    slots.set(key, found)
  }
  return slots.values()
}

// The data of `node` once `slot` follows a source of `type`.
function followedData(
  node: FollowNode,
  slot: FollowSlot,
  type: string,
  enumCasesOf: EnumCasesOf,
): Record<string, unknown> | undefined {
  if (slot.portId !== undefined) {
    return withOutputPortType(node.data, slot.portId, type, enumCasesOf)
  }
  const data = node.data ?? {}
  const next = dataOnConnect(data, slot.handle, type, enumCasesOf(type) !== undefined)
  return next === data ? node.data : next
}

// An output port of a value type, a primitive, an object or an enum, carries
// the type of its inner source.
function withOutputPortType(
  data: Record<string, unknown> | undefined,
  portId: string,
  type: string,
  enumCasesOf: EnumCasesOf,
): Record<string, unknown> | undefined {
  const ports = portsOf(data)
  const port = ports.outputs.find((p) => p.id === portId)
  const carriesValue = (t: string) => isValueType(t) || enumCasesOf(t) !== undefined
  if (!port || port.handleType === type || !carriesValue(port.handleType) || !carriesValue(type)) {
    return data
  }
  const outputs = ports.outputs.map((p) => (p === port ? { ...p, handleType: type } : p))
  return { ...(data as unknown as SubgraphData), ports: { ...ports, outputs } } as unknown as Record<string, unknown>
}
