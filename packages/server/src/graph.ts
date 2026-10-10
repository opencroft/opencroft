/** `@opencroft/server/graph` — the graph's nodes, edges and handles, across every space. */

export interface GraphNodeRecord {
  id: string
  type?: string
  position: { x: number; y: number }
  data: Record<string, unknown>
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
  /** The node's name, falling back to its type. */
  nodeName: string
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
  listNodesByType(type: string): Promise<GraphNodeRecord[]>
  listEdges(): Promise<GraphEdgeRecord[]>
  /**
   * Every handle matching `filter` that a node or App instance offers, across
   * every space, with dynamic handles expanded to their live ids. Uncached:
   * expanding asks each owner what is live (a docker host what is running, an
   * App what it has), so the answer holds only at the moment it is produced
   * and takes as long as the slowest owner.
   */
  listHandles(filter?: ListHandlesFilter): Promise<HandleInfo[]>
  updateNode(nodeId: string, patch: Partial<GraphNodeRecord>): Promise<GraphNodeRecord | null>
  /**
   * Create a node on the graph at `address` — a space slug (its default graph)
   * or `<space>.<graph>`. Required: there is no default graph to fall back to.
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
