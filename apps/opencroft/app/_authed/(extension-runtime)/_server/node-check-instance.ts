// The instance as node checks see it (`NodeCheckInstance` in
// `@opencroft/server/graph`), and which graphs' checks read which node types
// through it, so a change to those types on another graph checks them again.
//
// One view serves one check pass over one graph. It indexes the instance's
// graphs the first time a check asks, never when none does, and copies a
// type's records once, the first time that type is asked for. The graph being
// checked stands in for its registry copy, which is the graph as it was before
// the write being checked.
//
// Each record names its node's graph by address, so a graph whose address
// moves (renamed, transferred, or its space renamed) is a change to every
// record of the types it holds.

import type { EnumCasesOf } from '@opencroft/core/values'
import type { NodeCheckEdge, NodeCheckInstance, NodeCheckRecord } from '@opencroft/server/graph'

import { qualifyType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { wiredEdgesOf } from '@/app/_authed/(extension-runtime)/_wired-edges'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

/** A graph a check pass reads: its id, its address and its nodes and edges. */
export interface InstanceGraph {
  id: string
  address: string
  graph: GraphData
}

interface StoredNode {
  id: string
  type?: unknown
  data?: Record<string, unknown>
}

interface IndexedNode {
  node: StoredNode
  entry: InstanceGraph
}

/** What a graph's last check pass read through its view, and the node types the graph held. */
interface GraphReads {
  reads: ReadonlySet<string>
  holds: ReadonlySet<string>
}

// Kept on globalThis so a module reload in development keeps what the passes recorded.
const shared = globalThis as unknown as { __nodeCheckReads?: Map<string, GraphReads> }
if (!shared.__nodeCheckReads) {
  shared.__nodeCheckReads = new Map()
}
const readsByGraph = shared.__nodeCheckReads

/** The instance's graphs as the registry holds them now. */
function registryGraphs(): InstanceGraph[] {
  const registry = getSpacesRegistry()
  return registry
    .listGraphs()
    .map((ref) => ({ id: ref.graph.id, address: registry.addressOf(ref), graph: ref.graph.graph }))
}

/**
 * Each node's edges, those that start or end at it, by node id, as wiring
 * reads them (see `wiredEdges`): through a subgraph port, from or to the real
 * node at the other end.
 */
export function edgesByNode(graph: GraphData): Map<string, NodeCheckEdge[]> {
  const byNode = new Map<string, NodeCheckEdge[]>()
  const add = (nodeId: string, edge: NodeCheckEdge) => {
    const list = byNode.get(nodeId)
    if (list) {
      list.push(edge)
    } else {
      byNode.set(nodeId, [edge])
    }
  }
  for (const edge of wiredEdgesOf<NodeCheckEdge>(graph)) {
    add(edge.source, edge)
    if (edge.target !== edge.source) {
      add(edge.target, edge)
    }
  }
  return byNode
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
  }
  return value
}

/** The node types `graph` holds. */
function typesOf(graph: GraphData): Set<string> {
  const types = new Set<string>()
  for (const node of graph.nodes as unknown as StoredNode[]) {
    if (typeof node.type === 'string') {
      types.add(node.type)
    }
  }
  return types
}

export interface NodeCheckPass {
  /** The view a check of an extension's node type is told. */
  instanceFor(extensionId: string): NodeCheckInstance
  /** Records that a check of the host's own read nodes of the qualified `type` on other graphs. */
  read(type: string): void
  /** Records what the pass's checks read, as what the checked graph depends on. */
  finish(): void
}

/**
 * A check pass over `checked`. Without `checked` (a graph that is no graph of
 * the instance) the view reads the registry alone and nothing is recorded.
 * `enumCasesOf` gives the enums the installed extensions declare, as the view
 * tells them. `graphs` gives the instance's graphs; the registry's by default.
 */
export function nodeCheckPass(
  checked: InstanceGraph | undefined,
  enumCasesOf: EnumCasesOf,
  graphs: () => InstanceGraph[] = registryGraphs,
): NodeCheckPass {
  const reads = new Set<string>()
  let index: Map<string, IndexedNode[]> | null = null
  const records = new Map<string, readonly NodeCheckRecord[]>()
  const edgesOf = new Map<InstanceGraph, Map<string, NodeCheckEdge[]>>()

  const indexed = () => {
    if (!index) {
      index = new Map()
      const entries = graphs().filter((entry) => entry.id !== checked?.id)
      for (const entry of checked ? [checked, ...entries] : entries) {
        for (const node of entry.graph.nodes as unknown as StoredNode[]) {
          if (typeof node.type !== 'string') {
            continue
          }
          const list = index.get(node.type)
          if (list) {
            list.push({ node, entry })
          } else {
            index.set(node.type, [{ node, entry }])
          }
        }
      }
    }
    return index
  }

  const recordsOf = (type: string): readonly NodeCheckRecord[] => {
    const cached = records.get(type)
    if (cached) {
      return cached
    }
    const list = (indexed().get(type) ?? []).map(({ node, entry }) => {
      let edges = edgesOf.get(entry)
      if (!edges) {
        edges = edgesByNode(entry.graph)
        edgesOf.set(entry, edges)
      }
      return deepFreeze({
        id: node.id,
        data: structuredClone(node.data ?? {}),
        graph: entry.address,
        edges: (edges.get(node.id) ?? []).map(({ source, target, sourceHandle, targetHandle }) => ({
          source,
          target,
          sourceHandle,
          targetHandle,
        })),
      })
    })
    const frozen = Object.freeze(list)
    records.set(type, frozen)
    return frozen
  }

  return {
    instanceFor(extensionId) {
      return {
        nodesOfType(type) {
          const qualified = qualifyType(extensionId, type)
          reads.add(qualified)
          return recordsOf(qualified)
        },
        enumCasesOf,
      }
    },
    read(type) {
      reads.add(type)
    },
    finish() {
      if (checked) {
        readsByGraph.set(checked.id, { reads, holds: typesOf(checked.graph) })
      }
    },
  }
}

/**
 * The ids of the graphs, other than `graphId`, whose last check pass read one
 * of the node types `before` or `after` holds on a node that differs between
 * them: one changed, added or removed, or one whose edges did, since a record
 * carries its node's edges. An edge counts when it was added or removed, or
 * its ends moved; a change to its data alone is not in any record.
 */
export function graphsReadingChanges(
  graphId: string,
  before: GraphData,
  after: GraphData,
  changes: { nodeIds: readonly string[]; edgeIds: readonly string[] },
): string[] {
  const changed = new Set(changes.nodeIds)
  if (changes.edgeIds.length > 0) {
    const ends = (graph: GraphData) =>
      new Map(graph.edges.map((edge) => [edge.id as string, edge as unknown as NodeCheckEdge]))
    const was = ends(before)
    const now = ends(after)
    // A stored edge through a subgraph port is part of the wired edges between
    // the real ends, whose records carry them too.
    const joined = (graph: GraphData) => {
      const byStored = new Map<string, NodeCheckEdge[]>()
      for (const edge of wiredEdgesOf<NodeCheckEdge>(graph)) {
        for (const id of edge.via ?? []) {
          byStored.set(id, [...(byStored.get(id) ?? []), edge])
        }
      }
      return byStored
    }
    const wasJoined = joined(before)
    const nowJoined = joined(after)
    for (const id of changes.edgeIds) {
      const a = was.get(id)
      const b = now.get(id)
      if (a && b && sameEnds(a, b)) {
        continue
      }
      for (const edge of [a, b, ...(wasJoined.get(id) ?? []), ...(nowJoined.get(id) ?? [])]) {
        if (edge) {
          changed.add(edge.source)
          changed.add(edge.target)
        }
      }
    }
  }
  if (changed.size === 0) {
    return []
  }
  const types = new Set<string>()
  for (const node of [...before.nodes, ...after.nodes] as unknown as StoredNode[]) {
    if (changed.has(node.id) && typeof node.type === 'string') {
      types.add(node.type)
    }
  }
  return graphsReading(types, new Set([graphId]))
}

function sameEnds(a: NodeCheckEdge, b: NodeCheckEdge): boolean {
  return (
    a.source === b.source &&
    a.target === b.target &&
    (a.sourceHandle ?? null) === (b.sourceHandle ?? null) &&
    (a.targetHandle ?? null) === (b.targetHandle ?? null)
  )
}

/**
 * Forgets what the deleted graphs' checks read, and gives the ids of the
 * graphs whose checks read a node type one of them held. A deleted graph no
 * pass ever recorded may have held any type, so every graph that reads any
 * type is given then.
 */
export function graphsReadingRemoved(graphIds: readonly string[]): string[] {
  const removed = new Set(graphIds)
  const types = new Set<string>()
  let unknown = false
  for (const graphId of graphIds) {
    const recorded = readsByGraph.get(graphId)
    if (!recorded) {
      unknown = true
      continue
    }
    for (const type of recorded.holds) {
      types.add(type)
    }
    readsByGraph.delete(graphId)
  }
  if (unknown) {
    return [...readsByGraph].filter(([id, { reads }]) => !removed.has(id) && reads.size > 0).map(([id]) => id)
  }
  return graphsReading(types, removed)
}

/**
 * The ids of the graphs whose checks read a node type one of the moved graphs
 * holds, since each record carries its node's graph address. A moved graph is
 * among them when its own checks read a type it holds: its own records carry
 * its address too. `graphs` gives the instance's graphs, already at their new
 * addresses; the registry's by default.
 */
export function graphsReadingMoved(
  graphIds: readonly string[],
  graphs: () => InstanceGraph[] = registryGraphs,
): string[] {
  const moved = new Set(graphIds)
  const types = new Set<string>()
  for (const entry of graphs()) {
    if (moved.has(entry.id)) {
      for (const type of typesOf(entry.graph)) {
        types.add(type)
      }
    }
  }
  return graphsReading(types, new Set())
}

function graphsReading(types: ReadonlySet<string>, except: ReadonlySet<string>): string[] {
  if (types.size === 0) {
    return []
  }
  const dependents: string[] = []
  for (const [id, { reads }] of readsByGraph) {
    if (!except.has(id) && [...reads].some((type) => types.has(type))) {
      dependents.push(id)
    }
  }
  return dependents
}
