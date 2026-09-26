/** The graph's read actions: nodes by listing, by search and by id, and its edges. None writes anything. */

import {
  edgeToApi,
  formatEndpoint,
  type GraphNode,
  graphTarget,
  loadOrFail,
  requireArray,
  type StoredEdge,
} from '@/app/_authed/(apps)/_server/graph-actions/graph-target'
import type { HostAppAction } from '@/app/_authed/(apps)/_server/host-apps'
import { loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import {
  buildNodeTypeHandles,
  expandDynamicHandles,
  findDockerExtensionId,
} from '@/app/_authed/(extension-runtime)/_server/node-handles'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

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

export const readActions: HostAppAction[] = [
  {
    id: 'listNodes',
    description: 'List all nodes in this graph. Returns a compact array of `{ id, name }` entries.',
    inputSchema: { type: 'object', properties: {} },
    run: async (ctx) => {
      const { address } = await graphTarget(ctx)
      const { graph } = await loadOrFail(address)
      const typeNames = await buildTypeNameMap()
      const entries = graph.nodes.map((n) => {
        const node = n as unknown as GraphNode
        return { id: node.id, name: nodeName(node, typeNames) }
      })
      return JSON.stringify(entries, null, 2)
    },
  },
  {
    id: 'findNodes',
    description:
      'Find nodes in this graph whose name, type, or data fields match any of the given glob patterns (case-insensitive). Use `*` and `?` wildcards.',
    inputSchema: {
      type: 'object',
      properties: {
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns (e.g. ["*server*", "WSL"]).',
          minItems: 1,
        },
      },
      required: ['patterns'],
    },
    run: async (ctx, params) => {
      const patterns = requireArray<string>(params.patterns, 'patterns')
      const { address } = await graphTarget(ctx)
      const { graph } = await loadOrFail(address)
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
      return JSON.stringify(results, null, 2)
    },
  },
  {
    id: 'getNodes',
    description:
      'Get one or more nodes of this graph by ID. Returns `{ found: Node[], missing: string[] }`. Each found node includes a `handles: { input, output }` map: `input[handleId]` is `"node-id/handle-id"` for the connected source or `null`, `output[handleId]` is an array of connected target endpoints (empty if unconnected). Dynamic source handles are expanded to live ids (e.g. application nodes expose one `instance-terminal-<containerId>` per running instance).',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Unique node IDs to fetch.',
          minItems: 1,
        },
      },
      required: ['nodeIds'],
    },
    run: async (ctx, params) => {
      const nodeIds = requireArray<string>(params.nodeIds, 'nodeIds')
      const { address } = await graphTarget(ctx)
      const { graph } = await loadOrFail(address)
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
      return JSON.stringify({ found, missing }, null, 2)
    },
  },
  {
    id: 'listEdges',
    description: 'List all edges in this graph.',
    inputSchema: { type: 'object', properties: {} },
    run: async (ctx) => {
      const { address } = await graphTarget(ctx)
      const { graph } = await loadOrFail(address)
      const edges = graph.edges.map((e) => edgeToApi(e as StoredEdge))
      return JSON.stringify(edges, null, 2)
    },
  },
]
