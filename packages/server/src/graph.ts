/** `@opencroft/server/graph` — the graph's nodes, edges and handles, across every space. */

import type { NodeDataProblem, NodeError } from '@opencroft/core'
import type { EnumCasesOf } from '@opencroft/core/values'

/**
 * What is wrong with a node's data, from the data alone: each problem names
 * the field it is about. An empty list means the data is valid. Called with
 * the node's data as stored, which may be partial or hold values of any type,
 * so a missing field is read as its default rather than as a problem.
 * Synchronous and without side effects: it runs before every graph write and
 * after every edit, on the server only.
 *
 * - The graph actions (`createNodes`, `updateNodes`, `writeNodeProperty`,
 *   `editNodeProperty`) refuse a write that introduces a problem, naming its
 *   field. A problem the node already had does not refuse a write, so a node
 *   holding invalid data can still be changed, and fixed one field at a time.
 *   A problem is the one it had when its `path` and `title` are the same and
 *   the value at `path` is unchanged; the detail may change with other
 *   fields. So `path` names the field whose value is wrong, and `title` does
 *   not quote the value.
 * - Every node's current problems are stored on it as its errors under the
 *   source `data` (see `setNodeErrors`), so the card and the Errors tab show
 *   them and an agent reading the node gets them. Edits on the canvas are not
 *   refused: they are stored and checked like any other, then shown.
 * - Data already stored is never rewritten.
 *
 * A validator that throws is logged and treated as finding nothing.
 */
// Each node type reads its own data; see `NodeActionHandler` for why no one
// data type admits all of them.
// biome-ignore lint/suspicious/noExplicitAny: a map of validators each typed on its own data
export type NodeDataValidator<D = any> = (data: D) => NodeDataProblem[]

/** The `nodeDataValidators` export: each node type's data validator, by the node's bare type. */
export type NodeDataValidators = Record<string, NodeDataValidator>

/** An edge at a node, as a `NodeCheck` is told it. */
export interface NodeCheckEdge {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

/** A node of the extension's own type somewhere on the instance, as `NodeCheckInstance` tells it. */
export interface NodeCheckRecord {
  readonly id: string
  readonly data: Readonly<Record<string, unknown>>
  /** The address of the graph the node is on, `<space>.<graph>`. */
  readonly graph: string
  /** The edges that start or end at the node, on its graph. */
  readonly edges: readonly NodeCheckEdge[]
}

/**
 * The instance as a `NodeCheck` sees it: the nodes of the extension's own
 * types on every graph of every space. It reads the graphs as they were last
 * changed, except the graph being checked, which it reads as it is being
 * written, so a node is never seen twice or as it was before the change. The
 * records are frozen copies.
 *
 * What a graph's checks read here is recorded. When nodes of a type they read
 * change on another graph (their data, or an edge connected, removed or moved
 * at them), or a graph holding that type is deleted or takes a new address
 * (renamed, transferred, or its space renamed), the graph is checked again,
 * so its findings follow the rest of the instance. A check
 * that never calls it is checked only with its own graph.
 */
export interface NodeCheckInstance {
  /**
   * Every node of the bare type `type`, one of the calling extension's own,
   * on every graph, the node being checked included.
   */
  nodesOfType(type: string): readonly NodeCheckRecord[]
  /** The cases of each enum the installed extensions declare (`@opencroft/server/values`), for a check that reads an enum input through them. */
  enumCasesOf: EnumCasesOf
}

/**
 * What is wrong with a node given its data and its wiring, such as a required
 * output left unconnected. Told the node, the edges that start or end at it,
 * and the instance, for a finding about the node's relation to nodes on other
 * graphs. Synchronous and without side effects: it runs on the server whenever
 * the graph changes, whenever a type it reads through `instance` changes on
 * another graph, and on every graph read. Its findings depend on what it is
 * told alone and come in a stable order, so checking a graph again over the
 * same instance finds the same list and writes nothing.
 *
 * - Every node's current findings are stored on it as its errors under the
 *   source `check` (see `setNodeErrors`), so the card, the Errors tab and an
 *   agent reading the node (`getNodes`, `findNodes`) all show the same list.
 *   An edge connected or removed clears or raises them like a data change.
 *   A finding another source already reports on the node (an action that
 *   refused for the same reason) is left out, so it shows once.
 * - Unlike a `NodeDataValidator`, a finding never refuses a write: a graph is
 *   built one node and one edge at a time, so it is incomplete on the way.
 *
 * A check that throws is logged and treated as finding nothing.
 */
// biome-ignore lint/suspicious/noExplicitAny: a map of checks each typed on its own data
export type NodeCheck<D = any> = (
  node: { id: string; data: D },
  edges: readonly NodeCheckEdge[],
  instance: NodeCheckInstance,
) => NodeError[]

/** The `nodeChecks` export: each node type's check, by the node's bare type. */
export type NodeChecks = Record<string, NodeCheck>

/**
 * How the host learns the live ids of a node type's `dynamic` source handles.
 * A dynamic handle's declared id is a prefix; its live ids depend on the node
 * (a route per entry in its data, a container per replica). Every handle
 * listing goes through it: the terminal pickers, a node read's outputs
 * (`getNodes`) and `graph.listHandles`. Declaring a dynamic terminal and
 * answering its ids here is all it takes for a node to be listed.
 */
// biome-ignore lint/suspicious/noExplicitAny: a map of listers each typed on its own data
export interface DynamicHandleLister<D = any> {
  /**
   * The node's live ids under `handleId`, the declared prefix; the host keeps
   * only the ids that start with it. Called once per declared dynamic source
   * handle, uncached. An empty list, a throw or a rejection lists none: the
   * node offers no terminal there and the rest of the listing goes on.
   */
  list(node: { id: string; data: D }, handleId: string): string[] | Promise<string[]>
  /**
   * `list` reads the node's data alone, with no I/O. The host then asks it in
   * the listing's first answer, so a picker shows those handles at once.
   * Without it the host asks it per node, after the first answer, so a slow
   * answer keeps only that node's group loading.
   */
  fromData?: true
}

/** The `dynamicHandles` export: each node type's lister, by the node's bare type. */
export type DynamicHandles = Record<string, DynamicHandleLister>

export interface GraphNodeRecord {
  id: string
  type?: string
  /**
   * Where the node's top-left corner is drawn on its canvas, whether or not
   * it is inside a frame: the top level's, or for a node inside a subgraph
   * that subgraph's own.
   */
  position: { x: number; y: number }
  /** The frame (a node such as a Section or a Network) or the subgraph the node is inside, when it is. */
  parentId?: string
  /** The nearest subgraph the node is inside, when it is in one: the canvas `position` is on. */
  subgraph?: string
  data: Record<string, unknown>
}

/**
 * A change to a node through `updateNode`. `position` is where its corner is
 * to be drawn; given without `parentId`, the node goes into the innermost frame
 * whose area holds it, or to the top level. `parentId` puts it in that frame,
 * `null` at the top level. A frame moved carries the nodes inside it.
 */
export interface GraphNodePatch {
  position?: { x: number; y: number }
  parentId?: string | null
  data?: Record<string, unknown>
}

export interface GraphEdgeRecord {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  data?: Record<string, unknown>
}

/** One handle a node or an App instance offers, as `HostGraphApi.listHandles` reports it. */
export interface HandleInfo {
  /** The node id, or the App instance id for an App's handle. */
  nodeId: string
  /** The space the owner is in, so a picker can say where a handle comes from. */
  spaceSlug: string
  /** The node's stored, qualified type; `app:<type>` for an App instance's handle. */
  type: string
  /** The node's name, falling back to its type; for an App's handle, the App's title. */
  nodeName: string
  /** For an App's handle: the instance's slug, unique in its space. Absent for a node's. */
  slug?: string
  /** For an App's handle: the instance's address, `<spaceSlug>.<slug>`. Absent for a node's. */
  address?: string
  /** For a node's handle: the graph the node is on, by its address (`<spaceSlug>.<graph>`) and name. Absent for an App's. */
  graph?: { address: string; name: string }
  /**
   * The live id, which `terminal.getContext` resolves. For a dynamic handle
   * this is the expanded runtime id, not the declared prefix.
   */
  handleId: string
  /** The manifest id: the prefix form for a dynamic handle. */
  declaredId: string
  /** The qualified handle type. */
  handleType: string
  role: 'source' | 'target'
  label?: string
  /** For an App's dynamic handle: what the App calls this live id, when it says. */
  liveLabel?: string
  dynamic: boolean
  /**
   * For a source handle: the name the host gives the terminal it is, e.g. in
   * the Terminal Selector. A node's is the node's name as the canvas shows it,
   * with which of its handles it is when that is something else
   * ("Docker · postgres"); an App's is what the App calls it ("my-repo · main"),
   * else the App's name. A router's route handle is the router's name and the
   * route's id ("Router · 3f9a1c2e"); where a route is chosen as a terminal, it
   * is named by the terminal it reaches instead.
   */
  title?: string
}

/** A handle type an extension declares, as `HostGraphApi.getHandleType` reports it. */
export interface HandleTypeRecord {
  /** Qualified: `<owner>.<extension>.<type>`. */
  id: string
  label: string
  color: string
  description?: string
  /** An enum's cases, in their declared order; absent for a type that is not an enum. */
  cases?: { value: string; label?: string }[]
}

export interface ListHandlesFilter {
  role?: 'source' | 'target'
  /** One of this extension's own handle types, bare, or any extension's, qualified. */
  handleType?: string
}

/**
 * The graph, across every space. Nodes come back with the type graphs store:
 * qualified with the declaring extension's id, `<owner>.<extension>.<type>`. A
 * type passed in is either one of this extension's own, bare, or any
 * extension's, qualified.
 */
export interface HostGraphApi {
  listNodes(): Promise<GraphNodeRecord[]>
  getNode(nodeId: string): Promise<GraphNodeRecord | null>
  /** The nodes on the one graph that holds `nodeId`, that node included; empty when no graph holds it. */
  listGraphNodes(nodeId: string): Promise<GraphNodeRecord[]>
  listNodesByType(type: string): Promise<GraphNodeRecord[]>
  /**
   * The edges as wiring reads them: an edge into or out of a subgraph's port
   * and the edge on the other side of that port come back as the one edge
   * between their real ends, so a node inside a subgraph is wired as it would
   * be outside one.
   */
  listEdges(): Promise<GraphEdgeRecord[]>
  /**
   * Every handle matching `filter` that a node or App instance offers, across
   * every space, with dynamic handles expanded to their live ids. Uncached:
   * expanding asks each owner what is live (an Application its replicas and
   * what its Docker host runs, an App what it has), so the answer holds only at the moment it is produced
   * and takes as long as the slowest owner.
   */
  listHandles(filter?: ListHandlesFilter): Promise<HandleInfo[]>
  /** The handle type `type` as its extension declares it, an enum's with its cases; null when no extension declares it. */
  getHandleType(type: string): Promise<HandleTypeRecord | null>
  /** Changes a node (see `GraphNodePatch`); refused, by throwing, for a `parentId` that is not a frame or does not hold `position`. */
  updateNode(nodeId: string, patch: GraphNodePatch): Promise<GraphNodeRecord | null>
  /**
   * Report what is wrong with a node: `errors` replace those `source` reported
   * before, and an empty list clears them. The node's card shows it is in
   * error, its inspector's Errors tab shows each one, and an agent reading the
   * node gets them as written. Name the source after the check
   * (`connection`), not the node; `action` is the host's, for node action
   * failures. Writes nothing when the errors are already the ones stored, so
   * a check can report on every run.
   */
  setNodeErrors(nodeId: string, source: string, errors: NodeError[]): Promise<void>
  /**
   * Create a node on the graph at `address` — a space slug (its default graph)
   * or `<space>.<graph>`. Required: there is no default graph to fall back to.
   * `data` is laid over the `defaultData` the type's client declaration gives,
   * field by top-level field, as the palette creates it. `position` is where
   * its corner is drawn; it goes into the innermost frame whose area holds it.
   */
  createNode(
    address: string,
    type: string,
    data: Record<string, unknown>,
    position: { x: number; y: number },
  ): Promise<GraphNodeRecord>
  deleteNode(nodeId: string): Promise<void>
}

export declare const graph: HostGraphApi
