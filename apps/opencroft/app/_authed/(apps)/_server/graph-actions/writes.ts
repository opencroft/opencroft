/**
 * The graph's write actions: node CRUD, node properties by path, and edges.
 * Every one queues for approval, and every one writes through the graph's
 * document, so a concurrent canvas edit is merged, not lost.
 */

import {
  EDGE_ENDPOINT_DESCRIPTION,
  edgeMatches,
  edgeToApi,
  type GraphNode,
  graphTarget,
  requireArray,
  type StoredEdge,
} from '@/app/_authed/(apps)/_server/graph-actions/graph-target'
import {
  resolveExisting,
  resolveForUnset,
  resolveForWrite,
} from '@/app/_authed/(apps)/_server/graph-actions/property-path'
import type { HostAppAction } from '@/app/_authed/(apps)/_server/host-apps'
import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { parseEndpoint } from '@/app/_authed/(mcp)/_server/endpoint'
import { replaceExact } from '@/app/_authed/(mcp)/_server/exact-replace'
import { fail } from '@/app/_authed/(mcp)/_server/tool-refusal'
import type { GraphWriteOrigin } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { newGraphId } from '@/lib/graph-id'

const POSITION_SCHEMA = {
  type: 'object',
  description: 'Canvas position',
  properties: {
    x: { type: 'number', description: 'X coordinate' },
    y: { type: 'number', description: 'Y coordinate' },
  },
  required: ['x', 'y'],
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
// change from its own.
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
  return mutateLiveGraph(address, origin, mutate)
}

export const writeActions: HostAppAction[] = [
  {
    id: 'createNodes',
    description:
      'Create one or more nodes in this graph. Each `type` is a node type an installed extension provides, qualified with that extension\'s id: `<owner>.<extension>.<type>` (e.g. "acme.widgets.gauge").',
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
              data: {
                type: 'object',
                description: 'Initial node data (shape depends on the extension)',
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
        // A bare name would be stored as a type no extension can claim.
        if (!parseType(it.type)) {
          fail(-32602, `"${it.type}" is not a qualified node type: expected <owner>.<extension>.<type>`)
        }
      }
      const { address } = await graphTarget(ctx)
      const created = await writeGraph(ctx, address, (graph) => {
        let maxY = graph.nodes.reduce((max, n) => {
          const py = (n as { position?: { y?: number } }).position?.y ?? 0
          return Math.max(max, py)
        }, 0)
        const createdNodes: GraphNode[] = []
        for (const it of items) {
          const userPos = it.position as { x: number; y: number } | undefined
          if (userPos) {
            maxY = Math.max(maxY, userPos.y)
          } else {
            maxY += 150
          }
          const position = userPos ?? { x: 100, y: maxY }
          const data = (it.data as Record<string, unknown>) ?? {}
          const node: GraphNode = {
            id: newGraphId(),
            type: it.type as string,
            position,
            data,
          }
          graph.nodes.push(node as unknown as Record<string, unknown>)
          createdNodes.push(node)
        }
        return createdNodes
      })
      return JSON.stringify(created)
    },
  },
  {
    id: 'updateNodes',
    description:
      "Update nodes' data and/or position (shallow merge). For long or multi-line string fields, prefer writeNodeProperty / editNodeProperty.",
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
      const { address } = await graphTarget(ctx)
      const updated = await writeGraph(ctx, address, (graph) => {
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
        const updatedNodes: GraphNode[] = []
        for (const it of items) {
          const node = index.get(it.nodeId as string)
          if (!node) {
            continue
          }
          const data = it.data as Record<string, unknown> | undefined
          if (data) {
            node.data = { ...(node.data ?? {}), ...data }
          }
          const position = it.position as { x: number; y: number } | undefined
          if (position) {
            node.position = position
          }
          updatedNodes.push(node)
        }
        return updatedNodes
      })
      return JSON.stringify(updated)
    },
  },
  {
    id: 'writeNodeProperty',
    description:
      'Write a property on a node at a dot path (e.g. "script", or "schedules.0.enabled" — an array index is its own dot segment; brackets are ordinary key characters, never an index). The value is written as given: a JSON boolean stays a boolean, so flags actually turn off. Paths are strict — every segment before the last must already exist, nothing is created implicitly, and an unresolvable path is refused naming the failing segment. Pass unset: true (omitting value) to remove the property instead. Preferred over updateNodes for multi-line strings and anything nested.',
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
      const { address } = await graphTarget(ctx)
      await writeGraph(ctx, address, (graph) => {
        const node = graph.nodes.find((n) => (n as { id: string }).id === nodeId) as GraphNode | undefined
        if (!node) {
          fail(-32602, `Node not found: ${nodeId}`)
        }
        if (!node.data) {
          node.data = {}
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
    description: 'Delete one or more nodes of this graph and all their connected edges.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Node IDs to delete.',
        },
      },
      required: ['nodeIds'],
    },
    requireApproval: true,
    approvalSpace,
    run: async (ctx, params) => {
      const nodeIds = requireArray<string>(params.nodeIds, 'nodeIds')
      const { address } = await graphTarget(ctx)
      const removedEdges = await writeGraph(ctx, address, (graph) => {
        const existing = new Set(graph.nodes.map((n) => (n as { id: string }).id))
        const missing = nodeIds.filter((id) => !existing.has(id))
        if (missing.length > 0) {
          fail(-32602, `Nodes not found: ${missing.join(', ')}`)
        }
        const targets = new Set(nodeIds)
        graph.nodes = graph.nodes.filter((n) => !targets.has((n as { id: string }).id))
        const beforeEdges = graph.edges.length
        graph.edges = graph.edges.filter((e) => {
          const edge = e as { source: string; target: string }
          return !targets.has(edge.source) && !targets.has(edge.target)
        })
        return beforeEdges - graph.edges.length
      })
      return JSON.stringify({ deleted: nodeIds, removedEdges })
    },
  },
  {
    id: 'connectNodes',
    description:
      'Connect nodes of this graph with one or more edges. Source and target handles must carry the same handle type (e.g. both "builtin.core.terminal-context").',
    inputSchema: { type: 'object', properties: { edges: EDGES_SCHEMA }, required: ['edges'] },
    requireApproval: true,
    approvalSpace,
    run: async (ctx, params) => {
      const items = requireArray<Record<string, unknown>>(params.edges, 'edges')
      const { address } = await graphTarget(ctx)
      const created = await writeGraph(ctx, address, (graph) => {
        const nodeIds = new Set(graph.nodes.map((n) => (n as { id: string }).id))
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
          graph.edges.push(edge)
          createdEdges.push(edgeToApi(edge))
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
]
