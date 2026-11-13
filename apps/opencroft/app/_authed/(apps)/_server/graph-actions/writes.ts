/**
 * The graph's write actions: node CRUD, node properties by path, and edges.
 * Every one queues for approval, and every one writes through the graph's
 * document, so a concurrent canvas edit is merged, not lost.
 */

import { isDeepStrictEqual } from 'node:util'

import { BOOLEAN_TYPE, INPUT_TYPES_KEY, isEnumHandle, NUMBER_TYPE, nodeName, STRING_TYPE } from '@opencroft/core/values'

import {
  EDGE_ENDPOINT_DESCRIPTION,
  edgeMatches,
  edgeToApi,
  formatEndpoint,
  type GraphNode,
  graphTarget,
  loadOrFail,
  requireArray,
  type StoredEdge,
} from '@/app/_authed/(apps)/_server/graph-actions/graph-target'
import {
  readEnumCases,
  readNodeTypes,
  requireRegisteredTypes,
} from '@/app/_authed/(apps)/_server/graph-actions/node-types'
import {
  resolveExisting,
  resolveForUnset,
  resolveForWrite,
} from '@/app/_authed/(apps)/_server/graph-actions/property-path'
import { findRedacted, nodeRedactor, REDACTED } from '@/app/_authed/(apps)/_server/graph-actions/redact-node-data'
import type { HostAppAction } from '@/app/_authed/(apps)/_server/host-apps'
import { isCallAction } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/call-action-shared'
import {
  isAutolayoutSection,
  SECTION_TYPE,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/section-shared'
import { portsProblem, SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import {
  type PlacementRequest,
  placeAbsolute,
  withoutStandingPlaces,
} from '@/app/_authed/(extension-runtime)/_frame-placement'
import {
  byIdOf,
  deletedWithContents,
  deleteKeepingChildren,
  UNSIZED_NODE,
  withAbsolutePositions,
  withLevels,
} from '@/app/_authed/(extension-runtime)/_frame-tree'
import { MIN_FRAME_SIZE, NEW_FRAME_SIZE, type NodeSize, newNodeLayout } from '@/app/_authed/(extension-runtime)/_frames'
import { ceilToGrid, GRID_STEP } from '@/app/_authed/(extension-runtime)/_grid'
import { edgesReplacedBy, takesOneEdge } from '@/app/_authed/(extension-runtime)/_input-edges'
import { connectRefusal, dataOnConnect, takesEdge } from '@/app/_authed/(extension-runtime)/_input-types'
import { dataRefusal } from '@/app/_authed/(extension-runtime)/_node-data-problems'
import { newNodeData } from '@/app/_authed/(extension-runtime)/_node-defaults'
import { routePathKeys, routePathRefusal } from '@/app/_authed/(extension-runtime)/_server/api-route-claims'
import { frameTest, frameTestOf } from '@/app/_authed/(extension-runtime)/_server/frame-types'
import { callActionDataOnWrite } from '@/app/_authed/(extension-runtime)/_server/graph-calls'
import { nodeDataSnapshot, problemsIntroduced } from '@/app/_authed/(extension-runtime)/_server/node-data-validation'
import { nodeTypeDefaults } from '@/app/_authed/(extension-runtime)/_server/provided-points'
import { routerRouteRefusal, routeTargetsOf } from '@/app/_authed/(extension-runtime)/_server/router-route-refusal'
import { expandSubgraph, handlesAt, makeSubgraph } from '@/app/_authed/(extension-runtime)/_subgraph-gestures'
import { type ExtensionHandle, findExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { loopRefusal, valueLoop } from '@/app/_authed/(extension-runtime)/_value-loops'
import { crossLevelRefusal, portEndProblem } from '@/app/_authed/(extension-runtime)/_wired-edges'
import { parseEndpoint } from '@/app/_authed/(mcp)/_server/endpoint'
import { replaceExact } from '@/app/_authed/(mcp)/_server/exact-replace'
import { fail } from '@/app/_authed/(mcp)/_server/tool-refusal'
import { describeSecretReference } from '@/app/_authed/(secrets-store)/_lib/secret-references'
import type { GraphWriteOrigin } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { newGraphId } from '@/lib/graph-id'
import { keyReferencesToStores } from '@/server/key-store-removal'
import { secrets } from '@/server/secrets'
import { deleteKeyStores, type KeyStoreHolding, keyStoresHolding } from '@/server/ssh-key-store'

const POSITION_SCHEMA = {
  type: 'object',
  description:
    "Where the node's top-left corner is drawn on its canvas, in that canvas's coordinates, whether or not it is inside a frame: the top level's, or for a node inside a subgraph that subgraph's own. Without parentId, the node goes into the innermost frame on its level whose area holds this point, or else stays on its level (a new node: the top level). Coordinates alone never put a node into a subgraph: name it as parentId. A frame grows to hold the whole node, with some padding.",
  properties: {
    x: { type: 'number', description: 'X coordinate' },
    y: { type: 'number', description: 'Y coordinate' },
  },
  required: ['x', 'y'],
}

const PARENT_ID_SCHEMA = {
  type: ['string', 'null'],
  description: `The frame (a node such as a Section or a Network that holds others) or subgraph to put the node in, or null for the top level. With a position, a frame's area must hold the node's top-left corner; without one, the node goes below the frame's lowest member. Either way the frame, and the frames around it, grow to hold the whole node (a node whose size the graph does not hold counts as ${UNSIZED_NODE.width} × ${UNSIZED_NODE.height}). In a subgraph, or in a frame inside one, the position is on that subgraph's canvas. Moving a node to another level drops its edges, which would cross levels.`,
}

const SIZE_SCHEMA = {
  type: 'object',
  description: `Size on the canvas, rounded up to the canvas grid (multiples of ${GRID_STEP}). For a frame (a node such as a Section that holds others) it is its area, which must hold every node inside it whole, with padding: a smaller size is refused, naming the smallest (a node whose size the graph does not hold counts as ${UNSIZED_NODE.width} × ${UNSIZED_NODE.height}). A node given none sizes to its content, or to its kind's default.`,
  properties: {
    width: { type: 'number', description: `Width, at least ${MIN_FRAME_SIZE.width}` },
    height: { type: 'number', description: `Height, at least ${MIN_FRAME_SIZE.height}` },
  },
  required: ['width', 'height'],
}

/** How far below the lowest node a node given no place goes: room for a card the server has no size for. */
const NEW_NODE_STEP = UNSIZED_NODE.height + GRID_STEP

/** A write's `parentId`: left out, `null` for the top level, or a node id. */
function readParentId(value: unknown, subject: string): string | null | undefined {
  if (value === undefined || value === null || typeof value === 'string') {
    return value
  }
  fail(-32602, `"parentId" of ${subject} must be a node id or null: got ${JSON.stringify(value)}`)
}

/** Applies `requests` to the graph's nodes, or refuses the write saying why. */
function placeOrFail(graph: GraphData, requests: PlacementRequest[], isFrame: (node: GraphNode) => boolean): void {
  const placed = placeAbsolute(graph.nodes as unknown as GraphNode[], requests, isFrame, isAutolayoutSection)
  if ('refused' in placed) {
    fail(-32602, placed.refused)
  }
  graph.nodes = placed.nodes as unknown as GraphData['nodes']
}

/** The nodes with ids in `ids`, as agents read them: positions absolute on their level, with `subgraph`. */
function nodesAsRead(graph: GraphData, ids: readonly string[]): GraphNode[] {
  const all = withLevels(withAbsolutePositions(graph.nodes as unknown as GraphNode[]))
  return ids.map((id) => all.find((n) => n.id === id)).filter((n): n is GraphNode => n !== undefined)
}

function readSize(value: unknown): NodeSize | undefined {
  if (value === undefined) {
    return undefined
  }
  const size = value as Partial<NodeSize> | null
  const { width, height } = size ?? {}
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < MIN_FRAME_SIZE.width ||
    height < MIN_FRAME_SIZE.height
  ) {
    fail(
      -32602,
      `"size" must be { width, height }, numbers of at least ${MIN_FRAME_SIZE.width} and ${MIN_FRAME_SIZE.height}: got ${JSON.stringify(value)}`,
    )
  }
  return { width: ceilToGrid(width), height: ceilToGrid(height) }
}

const EDGES_SCHEMA = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    properties: {
      source: { type: 'string', description: EDGE_ENDPOINT_DESCRIPTION },
      target: { type: 'string', description: EDGE_ENDPOINT_DESCRIPTION },
    },
    required: ['source', 'target'],
  },
}

/** Where a write's approval is shown: the space of the graph it writes. */
const approvalSpace = async (ctx: { instanceId: string }) => (await graphTarget(ctx)).spaceSlug

// Writes as whoever invoked the action, so a client can tell an agent's
// change from its own. Refused before anything is written: a write that gives
// an API Route a path another route on the instance has, in any space, one
// that gives a Terminal Router a route to another router's route, and one that
// gives a node data its type's validator finds a problem in that the node did
// not have before.
function writeGraph<T>(
  ctx: { callerAgent?: string; callerPerson?: { name: string } },
  address: string,
  mutate: (graph: GraphData) => T | Promise<T>,
): Promise<T> {
  const origin: GraphWriteOrigin = ctx.callerAgent
    ? { kind: 'agent', name: ctx.callerAgent }
    : ctx.callerPerson
      ? { kind: 'user', name: ctx.callerPerson.name }
      : { kind: 'system', name: 'graph action' }
  return mutateLiveGraph(address, origin, async (graph) => {
    const before = routePathKeys(graph)
    const routesBefore = routeTargetsOf(graph)
    const dataBefore = nodeDataSnapshot(graph)
    const result = await mutate(graph)
    const refusal = routePathRefusal(address, before, graph) ?? routerRouteRefusal(routesBefore, graph)
    if (refusal) {
      fail(-32602, refusal)
    }
    const introduced = await problemsIntroduced(dataBefore, graph)
    if (introduced.length > 0) {
      throw dataRefusal(introduced)
    }
    return result
  })
}

// Reads show `[redacted]` in place of a typed credential, so a node read,
// changed and written back whole would store the placeholder over the
// credential. Refused, naming where it is.
function refuseRedacted(value: unknown, subject: string): void {
  const path = findRedacted(value)
  if (path === undefined) {
    return
  }
  fail(
    -32602,
    `${subject} holds ${REDACTED} at ${path}: the placeholder a node read shows in place of a credential. Writing it would replace the credential. Leave that field out of the write, or give it a secret as secret:<NAME>.`,
  )
}

// A subgraph's ports are its handles: a write giving it `data.ports` that are
// not a list of ports is refused, naming what is wrong (see `portsProblem`).
function refuseBadPorts(type: string | undefined, data: Record<string, unknown> | undefined, subject: string): void {
  if (type !== SUBGRAPH_TYPE || !data || !Object.hasOwn(data, 'ports')) {
    return
  }
  const problem = portsProblem(data.ports)
  if (problem) {
    fail(-32602, `${subject}: ${problem}`)
  }
}

// A Call Action written with an `action` or a `target` and no `params` gets
// the snapshot of the action's parameters, and an app target given by address
// is stored by its instance id (see `callActionDataOnWrite`). Targets are
// looked up among `graph`'s nodes as they are being written first.
async function withCallActionData(
  graph: GraphData,
  spaceSlug: string,
  node: GraphNode,
  wrote: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = node.data ?? {}
  if (!isCallAction(node.type)) {
    return data
  }
  const nodes = graph.nodes as unknown as GraphNode[]
  const lookup = (id: string) => {
    const own = nodes.find((n) => n.id === id)
    return own ? { type: own.type, data: own.data, spaceSlug } : undefined
  }
  return callActionDataOnWrite(data, wrote, spaceSlug, lookup)
}

const INPUT_TYPES_SET_BY_CONNECTING = 'the type comes from what is connected; connect a value with connectNodes'

// The type of an input that takes several types follows what is connected
// into it (see `_input-types.ts`), so the canvas and the agents have one way
// to set it: a write giving `data.inputTypes` is refused, unless it gives
// them as they are (a node read and written back whole).
function refuseInputTypes(data: unknown, current: Record<string, unknown> | undefined, subject: string): void {
  if (!isPlainObject(data) || !Object.hasOwn(data, INPUT_TYPES_KEY)) {
    return
  }
  if (current && isDeepStrictEqual(data[INPUT_TYPES_KEY], current[INPUT_TYPES_KEY])) {
    return
  }
  fail(-32602, `${subject} writes data.${INPUT_TYPES_KEY}: ${INPUT_TYPES_SET_BY_CONNECTING}.`)
}

// The same for a write at a dot path into `inputTypes`.
function refuseInputTypesPath(propPath: string): void {
  if (propPath === INPUT_TYPES_KEY || propPath.startsWith(`${INPUT_TYPES_KEY}.`)) {
    fail(-32602, `${propPath} is not written by hand: ${INPUT_TYPES_SET_BY_CONNECTING}.`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// updateNodes merges by top-level field, except the values typed into the
// node's inputs: `inputs` is merged by handle, so writing one input keeps the
// others typed.
function mergedData(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...current, ...patch }
  if (isPlainObject(current.inputs) && isPlainObject(patch.inputs)) {
    merged.inputs = { ...current.inputs, ...patch.inputs }
  }
  return merged
}

interface TypedEnd {
  nodeId: string
  handle?: string
  /** The handles the node has at this end, as `connectNodes` reads them. */
  handles: readonly ExtensionHandle[]
}

// An edge joins handles when the target takes the source's type (see
// `handleTakes`): the rule the canvas draws by. A handle its node does not
// declare, or a boundary's empty slot, is not checked: nothing says what it
// carries. An input that takes several types takes exactly those, and only
// the one its group has now while another input of the group is wired by
// `edges`; an input port that takes several connects inside where the target
// takes any of them.
function typeRefusal(source: TypedEnd, target: TypedEnd, edges: readonly InputEdgeEnds[]): string | null {
  const from = source.handle ? findExtensionHandle(source.handles, source.handle, 'source') : undefined
  const to = target.handle ? findExtensionHandle(target.handles, target.handle, 'target') : undefined
  if (!from?.handleType || !to?.handleType) {
    return null
  }
  const types = from.accepts?.length ? from.accepts : [from.handleType]
  const isEnum = isEnumHandle(from)
  if (types.some((type) => takesEdge(target.nodeId, target.handles, to, type, edges, isEnum))) {
    return null
  }
  const carries = `${formatEndpoint(source.nodeId, source.handle)} carries ${from.handleType}${isEnum ? ' (an enum)' : ''}`
  const several = connectRefusal(target.nodeId, target.handles, to, from.handleType, edges, {
    subject: formatEndpoint(target.nodeId, target.handle),
    isEnum,
  })
  if (several) {
    return `${carries}. ${several}`
  }
  const into = isEnumHandle(to) ? `, and nothing but ${to.handleType} itself connects into an enum` : ''
  return `${carries} and ${formatEndpoint(target.nodeId, target.handle)} takes ${to.handleType}: an edge joins two handles of the same type, or a number (${NUMBER_TYPE}), a boolean (${BOOLEAN_TYPE}) or an enum into a text input (${STRING_TYPE}), which reads it as its text${into}. Any other change of type needs a conversion node between them.`
}

type InputEdgeEnds = Pick<StoredEdge, 'target' | 'targetHandle'>

/** The nodes among `nodeIds` that own stored secrets, as the stores they are. */
async function storesHoldingSecrets(nodeIds: string[]): Promise<{ storeId: string; keys: string[] }[]> {
  const ids = new Set(nodeIds)
  return (await secrets.listStores()).filter((store) => ids.has(store.storeId))
}

/** Each store as a refusal lists it: its id and how many items it holds. */
function listHolding(stores: { storeId: string; keys: string[] }[]): string {
  return stores.map((s) => `${s.storeId} (${s.keys.length})`).join(', ')
}

/** Named as the Secrets Store's own delete names its override, so one word means one thing to an agent. */
const PURGE_OVERRIDE_PARAM = 'allowUnclean'

/**
 * Why purging the stores is refused: nodes or Apps that are not among `deleting` still name their
 * secrets or keys, and stop resolving them at their next run, deploy or SSH connection. Null when
 * nothing does, or with `override`. Refused rather than done, as a single secret's or key's delete
 * is: an agent cannot be asked.
 */
async function refusePurge(
  secretStoreIds: string[],
  keyStores: KeyStoreHolding[],
  deleting: string[],
  override: boolean,
): Promise<string | null> {
  if (override || (secretStoreIds.length === 0 && keyStores.length === 0)) {
    return null
  }
  const [namedSecrets, namedKeys] = await Promise.all([
    secrets.referencesToStores(secretStoreIds, deleting),
    keyReferencesToStores(keyStores, deleting),
  ])
  const listed = [
    ...namedSecrets.map(({ key, references }) => `${key}: ${references.map(describeSecretReference).join(', ')}`),
    ...namedKeys.map(({ key, references }) => `key ${key}: ${references.map(describeSecretReference).join(', ')}`),
  ]
  if (listed.length === 0) {
    return null
  }
  return (
    `Refusing to purge: what the stores hold is still named by ${listed.join('; ')}. ` +
    `Those stop resolving it at their next run, deploy or SSH connection. Remove the references, or pass ${PURGE_OVERRIDE_PARAM}: true to purge anyway.`
  )
}

export const writeActions: HostAppAction[] = [
  {
    id: 'createNodes',
    description: `Create one or more nodes in this graph. Each \`type\` is a node type an installed extension provides, qualified with that extension's id: \`<owner>.<extension>.<type>\` (e.g. "acme.widgets.gauge"); listNodeTypes lists them, and a type no extension provides is refused. A frame (a node such as a Section that holds others) is created ${NEW_FRAME_SIZE.width} × ${NEW_FRAME_SIZE.height} and drawn behind other nodes, as from the palette; pass \`size\` to make it another size. \`position\` is absolute, where the node is drawn on its canvas. A node goes into the innermost frame whose area holds its \`position\`, or into the frame or subgraph \`parentId\` names, and a frame grows to hold the whole node; reads give each node's \`parentId\`. A subgraph's \`data.ports\` are its handles (see its description in listNodeTypes). A node with neither is put ${NEW_NODE_STEP} below the lowest node's top-left corner, at x 100, and goes into the innermost frame whose area holds that point, if there is one.`,
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Qualified node type, <owner>.<extension>.<type>' },
              position: POSITION_SCHEMA,
              parentId: PARENT_ID_SCHEMA,
              size: SIZE_SCHEMA,
              data: {
                type: 'object',
                description:
                  "Initial node data (shape depends on the extension). Laid over the type's default data, field by top-level field, as the palette creates it; leave a field out to get its default.",
                additionalProperties: true,
              },
            },
            required: ['type'],
          },
        },
      },
      required: ['nodes'],
    },
    requireApproval: true,
    approvalSpace,
    run: async (ctx, params) => {
      const items = requireArray<Record<string, unknown>>(params.nodes, 'nodes')
      for (const it of items) {
        if (!it.type || typeof it.type !== 'string') {
          fail(-32602, 'Each node must include a string "type"')
        }
        refuseRedacted(it.data, 'The node data')
        refuseInputTypes(it.data, undefined, 'The node data')
        refuseBadPorts(it.type, it.data as Record<string, unknown> | undefined, 'The node data')
      }
      const types = await readNodeTypes()
      requireRegisteredTypes(
        items.map((it) => it.type as string),
        types,
      )
      const sizes = items.map((it) => readSize(it.size))
      const parents = items.map((it, index) => readParentId(it.parentId, `node ${index}`))
      const layouts = items.map((it) => newNodeLayout(types.get(it.type as string)?.node))
      const defaults = await Promise.all(items.map((it) => nodeTypeDefaults(it.type as string)))
      const { address, spaceSlug } = await graphTarget(ctx)
      const created = await writeGraph(ctx, address, async (graph) => {
        // Below the lowest node of the top level: a node given no place is put there.
        const topLevel = withLevels(withAbsolutePositions(graph.nodes as unknown as GraphNode[])).filter(
          (n) => !n.subgraph,
        )
        let maxY = topLevel.reduce((max, n) => Math.max(max, n.position?.y ?? 0), 0)
        const ids: string[] = []
        const requests: PlacementRequest[] = []
        for (const [index, it] of items.entries()) {
          const parentId = parents[index]
          const userPos = it.position as { x: number; y: number } | undefined
          // A node put in a frame without a position takes its place there.
          let position = userPos
          if (userPos) {
            maxY = Math.max(maxY, userPos.y)
          } else if (!parentId) {
            maxY += NEW_NODE_STEP
            position = { x: 100, y: maxY }
          }
          const data = newNodeData(defaults[index], it.data as Record<string, unknown> | undefined)
          const { zIndex, style } = layouts[index]
          const size = sizes[index] ?? style
          const node: GraphNode = {
            id: newGraphId(),
            type: it.type as string,
            position: position ?? { x: 0, y: 0 },
            data,
            ...(zIndex === undefined ? {} : { zIndex }),
            ...(size ? { style: { ...size } } : {}),
          }
          graph.nodes.push(node as unknown as Record<string, unknown>)
          ids.push(node.id)
          requests.push({
            id: node.id,
            ...(position ? { position } : {}),
            ...(parentId === undefined ? {} : { parentId }),
          })
        }
        placeOrFail(graph, requests, frameTestOf([...types.values()].map((registered) => registered.node)))
        for (const [index, it] of items.entries()) {
          const node = (graph.nodes as unknown as GraphNode[]).find((n) => n.id === ids[index])
          if (node) {
            node.data = await withCallActionData(graph, spaceSlug, node, (it.data as Record<string, unknown>) ?? {})
          }
        }
        return nodesAsRead(graph, ids)
      })
      return JSON.stringify(created.map(await nodeRedactor(created)))
    },
  },
  {
    id: 'updateNodes',
    description:
      "Update nodes' data, position, frame and/or size (data is a shallow merge, except `data.inputs`, the values typed into the node's text, number and boolean inputs, which is merged by handle id: `{ inputs: { width: 640 } }` types one input and keeps the others; a value of the wrong type for its input is refused, naming the input and its type). Positions are absolute, where a node is drawn on its canvas, and every position given is final: a node not given one moves with the frame it is in, so moving a frame moves what is inside it, and a frame and its members moved in one call land where each was put. A node given a position and no parentId goes into the innermost frame whose area holds it, or to the top level; a position equal to where the node is drawn leaves it in its frame. A frame grows to hold a node placed, moved or resized in it, and a frame's size must hold every node inside it. A node inside a subgraph is placed on the subgraph's canvas; coordinates alone never move a node into a subgraph, parentId does. Writing a subgraph's `data.ports` adds, removes, renames and reorders its ports: a removed port's edges are removed in the same write, and a port's id cannot be changed (a new id is a new port). For long or multi-line string fields, prefer writeNodeProperty / editNodeProperty.",
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string', description: 'The unique node ID' },
              data: {
                type: 'object',
                description: "Partial data to merge into the node's data",
                additionalProperties: true,
              },
              position: POSITION_SCHEMA,
              parentId: PARENT_ID_SCHEMA,
              size: SIZE_SCHEMA,
            },
            required: ['nodeId'],
          },
        },
      },
      required: ['updates'],
    },
    requireApproval: true,
    view: 'graph.updateNodes',
    approvalSpace,
    run: async (ctx, params) => {
      const items = requireArray<Record<string, unknown>>(params.updates, 'updates')
      for (const it of items) {
        refuseRedacted(it.data, `The update of ${String(it.nodeId)}`)
      }
      const sizes = items.map((it) => readSize(it.size))
      const parents = items.map((it) => readParentId(it.parentId, String(it.nodeId)))
      const isFrame = await frameTest()
      const { address, spaceSlug } = await graphTarget(ctx)
      const updated = await writeGraph(ctx, address, async (graph) => {
        const index = new Map<string, GraphNode>()
        for (const n of graph.nodes) {
          const node = n as unknown as GraphNode
          index.set(node.id, node)
        }
        const missing: string[] = []
        for (const it of items) {
          const nodeId = it.nodeId as string | undefined
          if (!nodeId) {
            fail(-32602, 'Each update must include "nodeId"')
          }
          if (!index.has(nodeId)) {
            missing.push(nodeId)
          }
        }
        if (missing.length > 0) {
          fail(-32602, `Nodes not found: ${missing.join(', ')}`)
        }
        const requests: PlacementRequest[] = []
        for (const [i, it] of items.entries()) {
          const node = index.get(it.nodeId as string)
          if (!node) {
            continue
          }
          const data = it.data as Record<string, unknown> | undefined
          refuseInputTypes(data, node.data, `The update of ${node.id}`)
          refuseBadPorts(node.type, data, `The update of ${node.id}`)
          if (data) {
            node.data = mergedData(node.data ?? {}, data)
            node.data = await withCallActionData(graph, spaceSlug, node, data)
          }
          const position = it.position as { x: number; y: number } | undefined
          const size = sizes[i]
          const parentId = parents[i]
          // placeAbsolute writes a size through withSize: a node resized on
          // the canvas also holds its size as top-level width/height, which
          // the canvas draws first.
          requests.push({
            id: node.id,
            ...(position ? { position } : {}),
            ...(parentId === undefined ? {} : { parentId }),
            ...(size ? { size } : {}),
          })
        }
        placeOrFail(graph, withoutStandingPlaces(graph.nodes as unknown as GraphNode[], requests), isFrame)
        return nodesAsRead(
          graph,
          items.map((it) => it.nodeId as string),
        )
      })
      // The merged data carries every field the node already had, credentials included.
      return JSON.stringify(updated.map(await nodeRedactor(updated)))
    },
  },
  {
    id: 'writeNodeProperty',
    description:
      'Write a property on a node at a dot path (e.g. "script", or "schedules.0.enabled" — an array index is its own dot segment; brackets are ordinary key characters, never an index). The value is written as given: a JSON boolean stays a boolean, so flags actually turn off. Paths are strict — every segment before the last must already exist, nothing is created implicitly (except `inputs`, below), and an unresolvable path is refused naming the failing segment. Pass unset: true (omitting value) to remove the property instead. Preferred over updateNodes for multi-line strings and anything nested. A value typed into one of the node\'s text, number or boolean inputs is `inputs.<handle id>` (created on the first such write); it is refused when its input takes another type, and an edge into that input wins over it while connected.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The unique node ID' },
        path: { type: 'string', description: 'Dot path within node.data, e.g. "script" or "schedules.0.enabled".' },
        value: {
          description:
            'New value, written exactly as given (string, number, boolean, null, object or array). Omit when unset is true.',
        },
        unset: {
          type: 'boolean',
          description:
            'Remove the property at path instead of writing. The path must exist, and value must be omitted.',
        },
      },
      required: ['nodeId', 'path'],
    },
    requireApproval: true,
    view: 'graph.writeNodeProperty',
    approvalSpace,
    run: async (ctx, params) => {
      const nodeId = params.nodeId as string | undefined
      const propPath = params.path as string | undefined
      // The value is written EXACTLY as it arrived — a JSON boolean stays a
      // boolean. The string-only version of this could not turn a flag off:
      // consumers gate on truthiness and the string "false" is truthy, so a
      // disable written through here reported success and changed nothing.
      const value = params.value as unknown
      const unset = params.unset === true
      if (!nodeId || !propPath) {
        fail(-32602, 'Missing required params: nodeId, path')
      }
      if (unset === (value !== undefined)) {
        fail(-32602, 'Pass either a value to write, or unset: true to remove the property — exactly one of the two')
      }
      refuseRedacted(value, `The value for ${propPath}`)
      refuseInputTypesPath(propPath)
      const { address } = await graphTarget(ctx)
      await writeGraph(ctx, address, (graph) => {
        const node = graph.nodes.find((n) => (n as { id: string }).id === nodeId) as GraphNode | undefined
        if (!node) {
          fail(-32602, `Node not found: ${nodeId}`)
        }
        if (!node.data) {
          node.data = {}
        }
        // A node holds no `inputs` until a value is typed into one of them, so
        // the first `inputs.<handle>` written creates it.
        if (!unset && /^inputs\.[^.]+$/.test(propPath) && node.data.inputs === undefined) {
          node.data.inputs = {}
        }
        // Strict resolution: an unresolvable path is refused naming the
        // path, and nothing is created implicitly. The resolver this
        // replaced manufactured an object for every missing segment, so any
        // typo became a junk key and the call still answered success.
        const target = unset ? resolveForUnset(node.data, propPath) : resolveForWrite(node.data, propPath)
        if (!target.ok) {
          fail(-32602, target.reason)
        }
        if (unset) {
          delete (target.parent as Record<string, unknown>)[target.key as string]
        } else {
          ;(target.parent as Record<string, unknown>)[target.key as string] = value
        }
      })
      return unset ? `Property ${propPath} on ${nodeId} removed.` : `Property ${propPath} on ${nodeId} written.`
    },
  },
  {
    id: 'editNodeProperty',
    description:
      'Replace an exact string inside a node\'s string property at a dot path (an array index is its own dot segment, e.g. "schedules.0.cron"). The path must resolve to an existing string — an unresolvable path is refused naming the failing segment. Preferred over updateNodes for targeted edits in multi-line strings. Fails if oldString is not unique unless replaceAll is true.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The unique node ID' },
        path: { type: 'string', description: 'Dot path within node.data, e.g. "script".' },
        oldString: { type: 'string', description: 'The exact text to replace.' },
        newString: { type: 'string', description: 'The text to replace with.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['nodeId', 'path', 'oldString', 'newString'],
    },
    requireApproval: true,
    view: 'graph.editNodeProperty',
    approvalSpace,
    run: async (ctx, params) => {
      const nodeId = params.nodeId as string | undefined
      const propPath = params.path as string | undefined
      const oldString = params.oldString as string | undefined
      const newString = params.newString as string | undefined
      if (!nodeId || !propPath || oldString === undefined || newString === undefined) {
        fail(-32602, 'Missing required params: nodeId, path, oldString, newString')
      }
      if (oldString === newString) {
        fail(-32602, 'oldString and newString must differ')
      }
      refuseRedacted(newString, 'newString')
      refuseInputTypesPath(propPath)
      const replaceAll = Boolean(params.replaceAll)
      const { address } = await graphTarget(ctx)
      await writeGraph(ctx, address, (graph) => {
        const node = graph.nodes.find((n) => (n as { id: string }).id === nodeId) as GraphNode | undefined
        if (!node) {
          fail(-32602, `Node not found: ${nodeId}`)
        }
        // One resolution serves both the read and the write-back, so the
        // slot that was checked is the slot that is written — and a path
        // that does not resolve is refused by name instead of the old
        // behaviour, where the read came back undefined ("not a string")
        // while a later write would have invented the path.
        const target = resolveExisting(node.data ?? {}, propPath)
        if (!target.ok) {
          fail(-32602, target.reason)
        }
        const current = (target.parent as Record<string, unknown>)[target.key as string]
        if (typeof current !== 'string') {
          fail(-32602, `Property ${propPath} is not a string`)
        }
        const updated = replaceExact(current, { oldString, newString, replaceAll }, 'property')
        ;(target.parent as Record<string, unknown>)[target.key as string] = updated
      })
      return `Property ${propPath} on ${nodeId} updated.`
    },
  },
  {
    id: 'deleteNodes',
    description:
      "Delete one or more nodes of this graph and all their connected edges. The nodes inside a deleted frame stay where they are drawn, each in the nearest frame around the deleted one whose area holds its position, or on the level the frame was on. A deleted subgraph deletes everything inside it, at any depth, and the answer's `deleted` lists them. A Secrets Store that holds secrets is deleted only with purgeSecrets, which deletes its secrets too, and a Key Store that holds SSH keys only with purgeKeys, which deletes its keys too; either only with allowUnclean as well while a node or App outside the deletion still names one of them.",
    inputSchema: {
      type: 'object',
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Node IDs to delete.',
        },
        purgeSecrets: {
          type: 'boolean',
          description:
            'Also delete the secrets of every Secrets Store among the nodes. A deleted secret cannot be recovered; without this, deleting a store that holds any is refused.',
        },
        purgeKeys: {
          type: 'boolean',
          description:
            'Also delete the SSH keys of every Key Store among the nodes. A deleted key cannot be recovered; without this, deleting a store that holds any is refused.',
        },
        [PURGE_OVERRIDE_PARAM]: {
          type: 'boolean',
          description:
            'With purgeSecrets or purgeKeys: delete the stores even though nodes or Apps outside the deletion still name their secrets or keys. Those stop resolving at their next run, deploy or SSH connection.',
        },
      },
      required: ['nodeIds'],
    },
    requireApproval: true,
    approvalSpace,
    run: async (ctx, params) => {
      const asked = requireArray<string>(params.nodeIds, 'nodeIds')
      const { address } = await graphTarget(ctx)
      // What a deleted subgraph holds goes with it, its stores too, so they
      // are checked as if named.
      const { graph: current } = await loadOrFail(address)
      const nodeIds = [...deletedWithContents(current.nodes as unknown as GraphNode[], new Set(asked))]
      const holding = await storesHoldingSecrets(nodeIds)
      const holdingKeys = await keyStoresHolding(nodeIds)
      const unpurged = [
        holding.length > 0 && params.purgeSecrets !== true
          ? `Secrets Stores holding secrets: ${listHolding(holding)}. Pass purgeSecrets: true to delete them with their secrets, which cannot be recovered.`
          : null,
        holdingKeys.length > 0 && params.purgeKeys !== true
          ? `Key Stores holding SSH keys: ${listHolding(holdingKeys)}. Pass purgeKeys: true to delete them with their keys, which cannot be recovered.`
          : null,
      ].filter((refusal) => refusal !== null)
      if (unpurged.length > 0) {
        fail(-32602, unpurged.join(' '))
      }
      const purgeRefusal = await refusePurge(
        holding.map((s) => s.storeId),
        holdingKeys,
        nodeIds,
        params[PURGE_OVERRIDE_PARAM] === true,
      )
      if (purgeRefusal) {
        fail(-32602, purgeRefusal)
      }
      const removedEdges = await writeGraph(ctx, address, (graph) => {
        const existing = new Set(graph.nodes.map((n) => (n as { id: string }).id))
        const missing = asked.filter((id) => !existing.has(id))
        if (missing.length > 0) {
          fail(-32602, `Nodes not found: ${missing.join(', ')}`)
        }
        // A deleted frame's members stay where they are drawn, in a frame that
        // holds them; a deleted subgraph takes everything inside it.
        const targets = deletedWithContents(graph.nodes as unknown as GraphNode[], new Set(asked))
        // The stores were checked on the graph as loaded above; a node put into
        // a deleted subgraph since then has not been, so nothing is deleted.
        const checked = new Set(nodeIds)
        const unchecked = [...targets].filter((id) => !checked.has(id))
        if (unchecked.length > 0) {
          fail(
            -32602,
            `Nodes were added inside a subgraph being deleted while it was checked: ${unchecked.join(', ')}. Nothing was deleted; try again.`,
          )
        }
        graph.nodes = deleteKeepingChildren(
          graph.nodes as unknown as GraphNode[],
          targets,
        ) as unknown as GraphData['nodes']
        const beforeEdges = graph.edges.length
        graph.edges = graph.edges.filter((e) => {
          const edge = e as { source: string; target: string }
          return !targets.has(edge.source) && !targets.has(edge.target)
        })
        return beforeEdges - graph.edges.length
      })
      // After the nodes are gone: a purge that fails leaves orphan rows (every
      // Secrets Store's inspector lists orphan secrets for deletion) rather than
      // a store whose secrets or keys are lost while it stays on the graph.
      for (const { storeId } of holding) {
        await secrets.deleteStore(storeId)
      }
      await deleteKeyStores(holdingKeys.map((s) => s.storeId))
      const purgedSecrets = holding.reduce((sum, s) => sum + s.keys.length, 0)
      const purgedKeys = holdingKeys.reduce((sum, s) => sum + s.keys.length, 0)
      return JSON.stringify({
        deleted: nodeIds,
        removedEdges,
        ...(purgedSecrets > 0 ? { purgedSecrets } : {}),
        ...(purgedKeys > 0 ? { purgedKeys } : {}),
      })
    },
  },
  {
    id: 'connectNodes',
    description:
      'Connect nodes of this graph with one or more edges. Source and target handles must carry the same handle type (e.g. both "builtin.core.terminal-context"), with one widening: a "builtin.core.number" or "builtin.core.boolean" output connects to a "builtin.core.string" (text) input, which reads it as its text (`42`, `true`), and so does an enum output (a handle type listNodeTypes gives `cases`), read as its case\'s value (`png`); nothing but the same enum connects into an enum input. A "builtin.core.object" connects only to an object input. Any other pair is refused, naming both types. An output listNodeTypes marks `runtime: true` (the body of an API Route, the payload of an Event, the result of a Call Action) has a value only while the run of its node dispatches. An input that takes several types (listNodeTypes gives it `accepts`: a Switch\'s `condition`, a Select\'s `true` and `false`) takes exactly those (and every enum where it has `acceptsEnums`), nothing widened into it, and connecting one sets the node\'s `data.inputTypes.<group>` to the source\'s type, so the node\'s handles follow it: a Switch\'s outputs become True and False, its text cases and Default, or one output per case of the enum (`case-<value>`) and Default; a Select\'s True, False and Value take that type. Inputs of one `typeGroup` share one type: while one of them is wired, the others take only that type. The type stays when the edge is removed, and follows the source when the source\'s type changes. `data.inputTypes` is never written by hand. An edge into a text, number or boolean input wins over the value typed into it (`data.inputs`), which is kept and read again once the edge is removed. Edges between values never form a loop: an edge that would close one is refused, naming the nodes on it. An input takes one edge unless listNodeTypes marks it `multiple`: an edge into it replaces the edge already there, and the created edge then carries `replaced`, the edges it removed. An edge stays on one level: two nodes on different levels (the top level, or the canvas of a subgraph) are wired through a port of the subgraph between them. Add the port to its `data.ports` with updateNodes, then connect the outer node to `<subgraph>/in-<port>` and `<subgraph>/in-<port>` to the inner node (for an output port, the inner node to `<subgraph>/out-<port>` and `<subgraph>/out-<port>` to the outer node). Inside, an output port takes one edge. An input port passes straight through to an output port with the edge `<subgraph>/in-<port>` -> `<subgraph>/out-<port>`: what feeds the input outside then reaches what the output feeds. An edge between levels is refused, naming that route.',
    inputSchema: { type: 'object', properties: { edges: EDGES_SCHEMA }, required: ['edges'] },
    requireApproval: true,
    approvalSpace,
    run: async (ctx, params) => {
      const items = requireArray<Record<string, unknown>>(params.edges, 'edges')
      const { address } = await graphTarget(ctx)
      const types = await readNodeTypes()
      const enumCasesOf = await readEnumCases()
      const created = await writeGraph(ctx, address, (graph) => {
        const nodes = graph.nodes as unknown as GraphNode[]
        const byId = byIdOf(nodes)
        const nodeIds = new Set(byId.keys())
        // A subgraph's handles are its ports: on the card outside, and on its
        // boundaries inside, where an output takes one edge.
        const handlesOf = (nodeId: string, otherEnd: string) =>
          handlesAt(byId, nodeId, otherEnd, (type) => types.get(type)?.node.handles ?? [], enumCasesOf)
        const singleInputs = new Set<string>()
        // The edges into each input as they stand, with those of this call
        // before each one, so two inputs of one type group get one type.
        const into: InputEdgeEnds[] = [...(graph.edges as StoredEdge[])]
        const parsed = items.map((it) => {
          if (!it.source || !it.target || typeof it.source !== 'string' || typeof it.target !== 'string') {
            fail(-32602, 'Each edge must include "source" and "target"')
          }
          const source = parseEndpoint(it.source as string)
          const target = parseEndpoint(it.target as string)
          if (!nodeIds.has(source.nodeId)) {
            fail(-32602, `Source node not found: ${source.nodeId}`)
          }
          if (!nodeIds.has(target.nodeId)) {
            fail(-32602, `Target node not found: ${target.nodeId}`)
          }
          const exists = (graph.edges as StoredEdge[]).some((e) => edgeMatches(e, { source, target }))
          if (exists) {
            fail(-32602, `Edge already exists: ${it.source} -> ${it.target}`)
          }
          const ends = {
            source: source.nodeId,
            sourceHandle: source.handle,
            target: target.nodeId,
            targetHandle: target.handle,
          }
          const refusal =
            crossLevelRefusal(nodes, ends) ??
            portEndProblem(nodes, ends) ??
            typeRefusal(
              { ...source, handles: handlesOf(source.nodeId, target.nodeId) },
              { ...target, handles: handlesOf(target.nodeId, source.nodeId) },
              into,
            )
          if (refusal) {
            fail(-32602, refusal)
          }
          into.push({ target: target.nodeId, targetHandle: target.handle })
          // An input that takes several types takes the type of what is
          // connected into it, before the call's next edge is checked. A later
          // refusal fails the whole write, this with it.
          const targetNode = byId.get(target.nodeId)
          const fromHandle = source.handle
            ? findExtensionHandle(handlesOf(source.nodeId, target.nodeId), source.handle, 'source')
            : undefined
          const toHandle = target.handle
            ? findExtensionHandle(handlesOf(target.nodeId, source.nodeId), target.handle, 'target')
            : undefined
          const base = targetNode?.data ?? {}
          const retyped = dataOnConnect(
            base,
            toHandle,
            fromHandle?.handleType,
            fromHandle !== undefined && isEnumHandle(fromHandle),
          )
          if (targetNode && retyped !== base) {
            targetNode.data = retyped
          }
          if (target.handle && takesOneEdge(handlesOf(target.nodeId, source.nodeId), target.handle)) {
            const input = `${target.nodeId}/${target.handle}`
            if (singleInputs.has(input)) {
              fail(-32602, `${input} is a single input: connect one edge into it, not several in one call`)
            }
            singleInputs.add(input)
          }
          return { source, target }
        })
        const createdEdges: Record<string, unknown>[] = []
        for (const p of parsed) {
          const edge: StoredEdge = {
            id: newGraphId(),
            source: p.source.nodeId,
            target: p.target.nodeId,
          }
          if (p.source.handle) {
            edge.sourceHandle = p.source.handle
          }
          if (p.target.handle) {
            edge.targetHandle = p.target.handle
          }
          const replaced = edgesReplacedBy(graph.edges as StoredEdge[], edge, handlesOf(edge.target, edge.source))
          graph.edges = graph.edges.filter((e) => !replaced.includes(e as StoredEdge))
          graph.edges.push(edge)
          createdEdges.push({
            ...edgeToApi(edge),
            ...(replaced.length > 0 ? { replaced: replaced.map(edgeToApi) } : {}),
          })
        }
        const added = new Set(createdEdges.map((edge) => edge.id as string))
        const sourceType = (nodeId: string, handleId: string) =>
          findExtensionHandle(handlesOf(nodeId, nodeId), handleId, 'source')?.handleType
        const loop = valueLoop({ nodes, edges: graph.edges as StoredEdge[] }, added, sourceType)
        if (loop) {
          const named = (nodeId: string) => {
            const node = byId.get(nodeId)
            return `${nodeName(node?.data, types.get(node?.type ?? '')?.node.name, nodeId)} (${nodeId})`
          }
          fail(-32602, loopRefusal(loop, named))
        }
        return createdEdges
      })
      return JSON.stringify(created)
    },
  },
  {
    id: 'disconnectNodes',
    description: 'Remove one or more edges between nodes of this graph.',
    inputSchema: { type: 'object', properties: { edges: EDGES_SCHEMA }, required: ['edges'] },
    requireApproval: true,
    approvalSpace,
    run: async (ctx, params) => {
      const items = requireArray<Record<string, unknown>>(params.edges, 'edges')
      const { address } = await graphTarget(ctx)
      const removed = await writeGraph(ctx, address, (graph) => {
        const indices: number[] = []
        for (const it of items) {
          if (!it.source || !it.target || typeof it.source !== 'string' || typeof it.target !== 'string') {
            fail(-32602, 'Each edge must include "source" and "target"')
          }
          const source = parseEndpoint(it.source as string)
          const target = parseEndpoint(it.target as string)
          const idx = (graph.edges as StoredEdge[]).findIndex(
            (e, i) => !indices.includes(i) && edgeMatches(e, { source, target }),
          )
          if (idx === -1) {
            fail(-32602, `Edge not found: ${it.source} -> ${it.target}`)
          }
          indices.push(idx)
        }
        indices.sort((a, b) => b - a)
        const removedIds: string[] = []
        for (const idx of indices) {
          const edge = graph.edges.splice(idx, 1)[0] as StoredEdge
          removedIds.push(edge.id)
        }
        return removedIds
      })
      return JSON.stringify({ removed })
    },
  },
  {
    id: 'makeSubgraph',
    description:
      "Move nodes into a new subgraph, as the canvas's Make subgraph does. The nodes must be on one level (the top level, or one subgraph's canvas); a frame among them takes its members along, and a subgraph among them its contents. Every node keeps its id and its layout, and each edge that crosses the selection becomes a port, so every node stays wired to what it was: one input port per distinct outer source (node and handle) feeding every inner node it fed, and one output port per distinct inner source feeding every outer node. Ports are ordered top to bottom by their inner node and labelled with its handle's label. The subgraph is placed at the nodes' top-left, in the frame they shared or on their level. Returns the new subgraph's `id` and its `ports`.",
    inputSchema: {
      type: 'object',
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'The nodes to move into the subgraph.',
        },
        name: { type: 'string', description: 'The subgraph\'s name; "Subgraph" when left out.' },
      },
      required: ['nodeIds'],
    },
    requireApproval: true,
    approvalSpace,
    run: async (ctx, params) => {
      const nodeIds = requireArray<string>(params.nodeIds, 'nodeIds')
      const name = params.name
      if (name !== undefined && typeof name !== 'string') {
        fail(-32602, `"name" must be a string: got ${JSON.stringify(name)}`)
      }
      const types = await readNodeTypes()
      const enumCasesOf = await readEnumCases()
      const defaults = await nodeTypeDefaults(SUBGRAPH_TYPE)
      const { address } = await graphTarget(ctx)
      const made = await writeGraph(ctx, address, (graph) => {
        const subgraph: GraphNode = {
          id: newGraphId(),
          type: SUBGRAPH_TYPE,
          position: { x: 0, y: 0 },
          data: newNodeData(defaults, name ? { name } : undefined),
        }
        const result = makeSubgraph(
          { nodes: graph.nodes as unknown as GraphNode[], edges: graph.edges as StoredEdge[] },
          new Set(nodeIds),
          {
            subgraph,
            newId: newGraphId,
            declared: (type) => types.get(type)?.node.handles ?? [],
            enumCasesOf,
            fitsItself: isAutolayoutSection,
          },
        )
        if ('refused' in result) {
          fail(-32602, result.refused)
        }
        graph.nodes = result.nodes as unknown as GraphData['nodes']
        graph.edges = result.edges
        return { id: subgraph.id, ports: result.ports }
      })
      return JSON.stringify(made)
    },
  },
  {
    id: 'expandSubgraph',
    description:
      "Turn a subgraph into a Section in place, as the canvas's Expand subgraph does: the same id and position, its name as the Section's label, sized to hold what it held. The nodes inside keep their ids and layout and become the Section's members; each port's pairs of edges become the direct edges they stood for, so every node stays wired to what it was. Subgraphs inside stay subgraphs: one level is expanded. The frame the Section is in grows to hold it. Returns the Section as getNodes reads a node.",
    inputSchema: {
      type: 'object',
      properties: { nodeId: { type: 'string', description: 'The subgraph to expand.' } },
      required: ['nodeId'],
    },
    requireApproval: true,
    approvalSpace,
    run: async (ctx, params) => {
      const nodeId = params.nodeId
      if (typeof nodeId !== 'string' || nodeId === '') {
        fail(-32602, 'Missing required param: nodeId')
      }
      const types = await readNodeTypes()
      const defaults = await nodeTypeDefaults(SECTION_TYPE)
      const { zIndex } = newNodeLayout(types.get(SECTION_TYPE)?.node)
      const { address } = await graphTarget(ctx)
      const [section] = await writeGraph(ctx, address, (graph) => {
        const result = expandSubgraph(
          { nodes: graph.nodes as unknown as GraphNode[], edges: graph.edges as StoredEdge[] },
          nodeId,
          {
            section: { type: SECTION_TYPE, data: newNodeData(defaults), ...(zIndex === undefined ? {} : { zIndex }) },
            newId: newGraphId,
            fitsItself: isAutolayoutSection,
          },
        )
        if ('refused' in result) {
          fail(-32602, result.refused)
        }
        graph.nodes = result.nodes as unknown as GraphData['nodes']
        graph.edges = result.edges
        return nodesAsRead(graph, [nodeId])
      })
      return JSON.stringify(section)
    },
  },
]
