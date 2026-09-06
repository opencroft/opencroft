/** The graph family: node CRUD, edge CRUD, and the focus/comment overlays drawn on top of them. */

import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import { loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import {
  buildNodeTypeHandles,
  expandDynamicHandles,
  findDockerExtensionId,
} from '@/app/_authed/(extension-runtime)/_server/node-handles'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { resolveExisting, resolveForUnset, resolveForWrite } from '@/app/_authed/(mcp)/_server/property-path'
import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import {
  fail,
  type GraphNode,
  type ParsedEndpoint,
  parseEndpoint,
  replaceExact,
  resolveSpace,
  SPACE_PARAM,
  textResult,
} from '@/app/_authed/(mcp)/_server/tool-shared'
import { findSpaceByNodeImpl, loadSpaceGraphImpl } from '@/app/_authed/(space)/_server/actions-impl'
import { withGraphConflictRetry } from '@/app/_authed/(space)/_server/graph-conflict-retry'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { toastStore } from '@/lib/toast-store'

const POSITION_SCHEMA = {
  type: 'object',
  description: 'Canvas position',
  properties: {
    x: { type: 'number', description: 'X coordinate' },
    y: { type: 'number', description: 'Y coordinate' },
  },
  required: ['x', 'y'],
}

const EDGE_ENDPOINT_DESCRIPTION = 'Node ID, optionally with handle after a slash (e.g. "node-id/out").'

export const definitions = [
  {
    name: 'list_nodes',
    description: 'List all nodes in a space. Returns a compact array of `{ id, name }` entries.',
    inputSchema: { type: 'object' as const, properties: { ...SPACE_PARAM } },
  },
  {
    name: 'find_nodes',
    description:
      'Find nodes whose name, type, or data fields match any of the given glob patterns (case-insensitive). Use `*` and `?` wildcards.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns (e.g. ["*server*", "WSL"]).',
          minItems: 1,
        },
        ...SPACE_PARAM,
      },
      required: ['patterns'],
    },
  },
  {
    name: 'get_nodes',
    description:
      'Get one or more nodes from a space by ID. Returns `{ found: Node[], missing: string[] }`. Each found node includes a `handles: { input, output }` map: `input[handleId]` is `"node-id/handle-id"` for the connected source or `null`, `output[handleId]` is an array of connected target endpoints (empty if unconnected). Dynamic source handles are expanded to live ids (e.g. application nodes expose one `instance-terminal-<containerId>` per running instance).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Unique node IDs to fetch.',
          minItems: 1,
        },
        ...SPACE_PARAM,
      },
      required: ['nodeIds'],
    },
  },
  {
    name: 'create_nodes',
    description:
      'Create one or more nodes in a space. Each `type` must match a registered extension typeId (e.g. "server", "docker-service", "application").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Extension typeId' },
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
        ...SPACE_PARAM,
      },
      required: ['nodes'],
    },
  },
  {
    name: 'update_nodes',
    description:
      "Update nodes' data and/or position (shallow merge). For long or multi-line string fields, prefer write_node_property / edit_node_property.",
    inputSchema: {
      type: 'object' as const,
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
        ...SPACE_PARAM,
      },
      required: ['updates'],
    },
  },
  {
    name: 'write_node_property',
    description:
      'Write a property on a node at a dot path (e.g. "script", or "schedules.0.enabled" — an array index is its own dot segment; brackets are ordinary key characters, never an index). The value is written as given: a JSON boolean stays a boolean, so flags actually turn off. Paths are strict — every segment before the last must already exist, nothing is created implicitly, and an unresolvable path is refused naming the failing segment. Pass unset: true (omitting value) to remove the property instead. Preferred over update_nodes for multi-line strings and anything nested.',
    inputSchema: {
      type: 'object' as const,
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
        ...SPACE_PARAM,
      },
      required: ['nodeId', 'path'],
    },
  },
  {
    name: 'edit_node_property',
    description:
      'Replace an exact string inside a node\'s string property at a dot path (an array index is its own dot segment, e.g. "schedules.0.cron"). The path must resolve to an existing string — an unresolvable path is refused naming the failing segment. Preferred over update_nodes for targeted edits in multi-line strings. Fails if oldString is not unique unless replaceAll is true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeId: { type: 'string', description: 'The unique node ID' },
        path: { type: 'string', description: 'Dot path within node.data, e.g. "script".' },
        oldString: { type: 'string', description: 'The exact text to replace.' },
        newString: { type: 'string', description: 'The text to replace with.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
        ...SPACE_PARAM,
      },
      required: ['nodeId', 'path', 'oldString', 'newString'],
    },
  },
  {
    name: 'delete_nodes',
    description: 'Delete one or more nodes and all their connected edges.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Node IDs to delete.',
        },
        ...SPACE_PARAM,
      },
      required: ['nodeIds'],
    },
  },

  // ── Edge CRUD ─────────────────────────────────────────────────────
  {
    name: 'list_edges',
    description: 'List all edges in a space.',
    inputSchema: { type: 'object' as const, properties: { ...SPACE_PARAM } },
  },
  {
    name: 'connect_nodes',
    description: 'Connect nodes with one or more edges. Source and target handles must share the same contextType.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edges: {
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
        },
        ...SPACE_PARAM,
      },
      required: ['edges'],
    },
  },
  {
    name: 'disconnect_nodes',
    description: 'Remove one or more edges between nodes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edges: {
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
        },
        ...SPACE_PARAM,
      },
      required: ['edges'],
    },
  },

  // ── Focus & Comments ──────────────────────────────────────────────
  {
    name: 'focus_node',
    description:
      'Focus the camera on a node and select it. If the node lives in a different space, the UI switches to it first. If `comment` is provided, also attach a floating comment bubble to the node.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeId: { type: 'string', description: 'The node ID to focus on' },
        comment: { type: 'string', description: 'Optional comment to attach to the node.' },
      },
      required: ['nodeId'],
    },
  },
  {
    name: 'comment_nodes',
    description:
      'Attach floating comment bubbles to one or more nodes. Each node has at most one comment — subsequent calls replace the previous message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        comments: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string', description: 'The node ID to attach the comment to' },
              message: { type: 'string', description: 'Comment message text' },
            },
            required: ['nodeId', 'message'],
          },
        },
        ...SPACE_PARAM,
      },
      required: ['comments'],
    },
  },
  {
    name: 'uncomment_nodes',
    description: 'Remove comment bubbles from one or more nodes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Node IDs whose comments should be removed.',
        },
        ...SPACE_PARAM,
      },
      required: ['nodeIds'],
    },
  },
]

interface StoredEdge extends Record<string, unknown> {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

async function loadOrFail(slug: string): Promise<{ graph: GraphData; updatedAt: string }> {
  const result = await loadSpaceGraphImpl(slug)
  if (!result) {
    fail(-32602, `Graph not found: ${slug}`)
  }
  return result
}

function edgeMatches(edge: StoredEdge, endpoint: { source: ParsedEndpoint; target: ParsedEndpoint }): boolean {
  if (edge.source !== endpoint.source.nodeId || edge.target !== endpoint.target.nodeId) {
    return false
  }
  if (endpoint.source.handle !== undefined && edge.sourceHandle !== endpoint.source.handle) {
    return false
  }
  if (endpoint.target.handle !== undefined && edge.targetHandle !== endpoint.target.handle) {
    return false
  }
  return true
}

function formatEndpoint(nodeId: string, handle?: string): string {
  return handle ? `${nodeId}/${handle}` : nodeId
}

function edgeToApi(edge: StoredEdge): Record<string, unknown> {
  return {
    id: edge.id,
    source: formatEndpoint(edge.source, edge.sourceHandle),
    target: formatEndpoint(edge.target, edge.targetHandle),
  }
}

async function buildTypeNameMap(): Promise<Map<string, string>> {
  const manifests = await loadAllManifests()
  const map = new Map<string, string>()
  for (const manifest of manifests) {
    for (const node of manifest.nodes ?? []) {
      map.set(node.typeId, node.name)
    }
  }
  return map
}

interface TypeHandlesContext {
  typeHandles: Map<string, ExtensionHandle[]>
  // Resolved once here rather than per node inside the expansion.
  dockerExtensionId: string | null
}

async function buildTypeHandlesMap(): Promise<TypeHandlesContext> {
  const manifests = await loadAllManifests()
  const byType = buildNodeTypeHandles(manifests)
  return {
    typeHandles: new Map(Array.from(byType, ([typeId, entry]) => [typeId, entry.handles])),
    dockerExtensionId: findDockerExtensionId(manifests),
  }
}

interface NodeHandlesView {
  input: Record<string, string | null>
  output: Record<string, string[]>
}

async function nodeHandles(
  node: GraphNode,
  edges: StoredEdge[],
  { typeHandles, dockerExtensionId }: TypeHandlesContext,
): Promise<NodeHandlesView> {
  const input: Record<string, string | null> = {}
  const output: Record<string, string[]> = {}
  const declared = node.type ? (typeHandles.get(node.type) ?? []) : []
  for (const h of declared) {
    if (h.role === 'target') {
      input[h.id] = null
      continue
    }
    if (h.dynamic) {
      continue
    }
    output[h.id] = []
  }
  for (const id of await expandDynamicHandles(node, declared, dockerExtensionId)) {
    output[id] = []
  }
  for (const edge of edges) {
    if (edge.target === node.id && edge.targetHandle) {
      input[edge.targetHandle] = formatEndpoint(edge.source, edge.sourceHandle)
      continue
    }
    if (edge.source === node.id && edge.sourceHandle) {
      const list = output[edge.sourceHandle] ?? []
      list.push(formatEndpoint(edge.target, edge.targetHandle))
      output[edge.sourceHandle] = list
    }
  }
  return { input, output }
}

function nodeName(node: GraphNode, typeNames: Map<string, string>): string {
  const name = node.type ? typeNames.get(node.type) : undefined
  return name ?? node.type ?? node.id
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`, 'i')
}

function globLiteral(pattern: string): string {
  const parts = pattern.split(/[*?]+/).filter(Boolean)
  return parts.reduce((best, p) => (p.length > best.length ? p : best), '')
}

function snippet(value: string, pattern: string, radius = 100): string {
  const literal = globLiteral(pattern)
  if (!literal) {
    return value.length <= radius * 2 ? value : `${value.slice(0, radius * 2)}…`
  }
  const idx = value.toLowerCase().indexOf(literal.toLowerCase())
  if (idx === -1) {
    return value.length <= radius * 2 ? value : `${value.slice(0, radius * 2)}…`
  }
  const start = Math.max(0, idx - radius)
  const end = Math.min(value.length, idx + literal.length + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < value.length ? '…' : ''
  return prefix + value.slice(start, end) + suffix
}

function walkLeaves(value: unknown, path: string, out: Map<string, string>): void {
  if (value === null || value === undefined) {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      walkLeaves(item, `${path}[${i}]`, out)
    })
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = path ? `${path}.${k}` : k
      walkLeaves(v, next, out)
    }
    return
  }
  out.set(path, String(value))
}

function requireArray<T = unknown>(value: unknown, name: string): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(-32602, `Missing required param: ${name} (non-empty array)`)
  }
  return value as T[]
}

export const handlers: Record<string, ToolHandler> = {
  // ── list_nodes ──────────────────────────────────────────────────
  list_nodes: async (args) => {
    const slug = await resolveSpace(args)
    const { graph } = await loadOrFail(slug)
    const typeNames = await buildTypeNameMap()
    const entries = graph.nodes.map((n) => {
      const node = n as unknown as GraphNode
      return { id: node.id, name: nodeName(node, typeNames) }
    })
    return textResult(JSON.stringify(entries, null, 2))
  },

  // ── find_nodes ──────────────────────────────────────────────────
  find_nodes: async (args) => {
    const patterns = requireArray<string>(args.patterns, 'patterns')
    const slug = await resolveSpace(args)
    const { graph } = await loadOrFail(slug)
    const typeNames = await buildTypeNameMap()
    const regexes = patterns.map((p) => ({ pattern: p, regex: globToRegex(p) }))
    const results: Record<string, unknown>[] = []
    for (const n of graph.nodes) {
      const node = n as unknown as GraphNode
      const name = nodeName(node, typeNames)
      const hasName = name !== node.id && name !== node.type
      const fields = new Map<string, string>()
      if (hasName) {
        fields.set('name', name)
      }
      if (node.type) {
        fields.set('type', node.type)
      }
      if (node.data) {
        walkLeaves(node.data, 'data', fields)
      }
      const matches: Record<string, string> = {}
      for (const [path, value] of fields) {
        for (const { pattern, regex } of regexes) {
          if (regex.test(value)) {
            matches[path] = snippet(value, pattern)
            break
          }
        }
      }
      if (Object.keys(matches).length === 0) {
        continue
      }
      const entry: Record<string, unknown> = { id: node.id }
      if (hasName) {
        entry.name = name
      }
      if (node.type) {
        entry.type = node.type
      }
      if (node.position) {
        entry.position = node.position
      }
      entry.matches = matches
      results.push(entry)
    }
    return textResult(JSON.stringify(results, null, 2))
  },

  // ── get_nodes ───────────────────────────────────────────────────
  get_nodes: async (args) => {
    const nodeIds = requireArray<string>(args.nodeIds, 'nodeIds')
    const slug = await resolveSpace(args)
    const { graph } = await loadOrFail(slug)
    const typeHandles = await buildTypeHandlesMap()
    const edges = graph.edges as StoredEdge[]
    const index = new Map<string, GraphNode>()
    for (const n of graph.nodes) {
      index.set((n as unknown as GraphNode).id, n as unknown as GraphNode)
    }
    const found: unknown[] = []
    const missing: string[] = []
    for (const id of nodeIds) {
      const node = index.get(id)
      if (node) {
        found.push({ ...node, handles: await nodeHandles(node, edges, typeHandles) })
        continue
      }
      missing.push(id)
    }
    return textResult(JSON.stringify({ found, missing }, null, 2))
  },

  // ── create_nodes ────────────────────────────────────────────────
  create_nodes: withApprovalRequired(async (args) => {
    const items = requireArray<Record<string, unknown>>(args.nodes, 'nodes')
    for (const it of items) {
      if (!it.type || typeof it.type !== 'string') {
        fail(-32602, 'Each node must include a string "type"')
      }
    }
    const slug = await resolveSpace(args)
    const created = await withGraphConflictRetry(slug, (graph) => {
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
          id: crypto.randomUUID(),
          type: it.type as string,
          position,
          data,
        }
        graph.nodes.push(node as unknown as Record<string, unknown>)
        createdNodes.push(node)
      }
      return createdNodes
    })
    return textResult(JSON.stringify(created, null, 2))
  }),

  // ── update_nodes ────────────────────────────────────────────────
  update_nodes: withApprovalRequired(
    async (args) => {
      const items = requireArray<Record<string, unknown>>(args.updates, 'updates')
      const slug = await resolveSpace(args)
      const updated = await withGraphConflictRetry(slug, (graph) => {
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
      return textResult(JSON.stringify(updated, null, 2))
    },
    { view: 'update_nodes' },
  ),

  // ── write_node_property ─────────────────────────────────────────
  write_node_property: withApprovalRequired(
    async (args) => {
      const nodeId = args.nodeId as string | undefined
      const propPath = args.path as string | undefined
      // The value is written EXACTLY as it arrived — a JSON boolean stays a
      // boolean. The string-only version of this could not turn a flag off:
      // consumers gate on truthiness and the string "false" is truthy, so a
      // disable written through here reported success and changed nothing.
      const value = args.value as unknown
      const unset = args.unset === true
      if (!nodeId || !propPath) {
        fail(-32602, 'Missing required params: nodeId, path')
      }
      if (unset === (value !== undefined)) {
        fail(-32602, 'Pass either a value to write, or unset: true to remove the property — exactly one of the two')
      }
      const slug = await resolveSpace(args)
      await withGraphConflictRetry(slug, (graph) => {
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
      return textResult(
        unset ? `Property ${propPath} on ${nodeId} removed.` : `Property ${propPath} on ${nodeId} written.`,
      )
    },
    { view: 'write_node_property' },
  ),

  // ── edit_node_property ──────────────────────────────────────────
  edit_node_property: withApprovalRequired(
    async (args) => {
      const nodeId = args.nodeId as string | undefined
      const propPath = args.path as string | undefined
      const oldString = args.oldString as string | undefined
      const newString = args.newString as string | undefined
      if (!nodeId || !propPath || oldString === undefined || newString === undefined) {
        fail(-32602, 'Missing required params: nodeId, path, oldString, newString')
      }
      if (oldString === newString) {
        fail(-32602, 'oldString and newString must differ')
      }
      const replaceAll = Boolean(args.replaceAll)
      const slug = await resolveSpace(args)
      await withGraphConflictRetry(slug, (graph) => {
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
      return textResult(`Property ${propPath} on ${nodeId} updated.`)
    },
    { view: 'edit_node_property' },
  ),

  // ── delete_nodes ────────────────────────────────────────────────
  delete_nodes: withApprovalRequired(async (args) => {
    const nodeIds = requireArray<string>(args.nodeIds, 'nodeIds')
    const slug = await resolveSpace(args)
    const removedEdges = await withGraphConflictRetry(slug, (graph) => {
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
    return textResult(JSON.stringify({ deleted: nodeIds, removedEdges }, null, 2))
  }),

  // ── list_edges ──────────────────────────────────────────────────
  list_edges: async (args) => {
    const slug = await resolveSpace(args)
    const { graph } = await loadOrFail(slug)
    const edges = graph.edges.map((e) => edgeToApi(e as StoredEdge))
    return textResult(JSON.stringify(edges, null, 2))
  },

  // ── connect_nodes ───────────────────────────────────────────────
  connect_nodes: withApprovalRequired(async (args) => {
    const items = requireArray<Record<string, unknown>>(args.edges, 'edges')
    const slug = await resolveSpace(args)
    const created = await withGraphConflictRetry(slug, (graph) => {
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
          id: crypto.randomUUID(),
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
    return textResult(JSON.stringify(created, null, 2))
  }),

  // ── disconnect_nodes ────────────────────────────────────────────
  disconnect_nodes: withApprovalRequired(async (args) => {
    const items = requireArray<Record<string, unknown>>(args.edges, 'edges')
    const slug = await resolveSpace(args)
    const removed = await withGraphConflictRetry(slug, (graph) => {
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
    return textResult(JSON.stringify({ removed }, null, 2))
  }),

  // ── focus_node ──────────────────────────────────────────────────
  focus_node: async (args) => {
    const nodeId = args.nodeId as string | undefined
    if (!nodeId) {
      fail(-32602, 'Missing required param: nodeId')
    }
    const space = await findSpaceByNodeImpl(nodeId)
    if (!space) {
      fail(-32602, `Node not found in any space: ${nodeId}`)
    }
    toastStore.broadcast({ type: 'open_space', slug: space.slug, nodeId })
    toastStore.broadcast({ type: 'focus_node', nodeId, spaceId: space.slug })
    const comment = args.comment as string | undefined
    if (!comment) {
      return textResult(`Focused on node ${nodeId} in space ${space.slug}`)
    }
    toastStore.broadcast({ type: 'comment', message: comment, nodeId, spaceId: space.slug })
    return textResult(JSON.stringify({ nodeId, comment, space: space.slug }))
  },

  // ── comment_nodes ───────────────────────────────────────────────
  comment_nodes: async (args) => {
    const items = requireArray<Record<string, unknown>>(args.comments, 'comments')
    const entries: { nodeId: string; message: string }[] = []
    for (const it of items) {
      const nodeId = it.nodeId as string | undefined
      const message = it.message as string | undefined
      if (!nodeId || !message) {
        fail(-32602, 'Each comment must include "nodeId" and "message"')
      }
      entries.push({ nodeId, message })
    }
    const slug = await resolveSpace(args)
    for (const entry of entries) {
      toastStore.broadcast({ type: 'comment', message: entry.message, nodeId: entry.nodeId, spaceId: slug })
    }
    return textResult(JSON.stringify(entries, null, 2))
  },

  // ── uncomment_nodes ─────────────────────────────────────────────
  uncomment_nodes: async (args) => {
    const nodeIds = requireArray<string>(args.nodeIds, 'nodeIds')
    const slug = await resolveSpace(args)
    for (const nodeId of nodeIds) {
      toastStore.broadcast({ type: 'clear_comment', nodeId, spaceId: slug })
    }
    return textResult(JSON.stringify({ cleared: nodeIds }, null, 2))
  },
}
