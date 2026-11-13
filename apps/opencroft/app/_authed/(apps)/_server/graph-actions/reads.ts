/** The graph's read actions: nodes by listing, by search and by id, the node types it can hold, and its edges. None writes anything. */

import { type EnumCasesOf, takesSeveralTypes } from '@opencroft/core/values'

import {
  edgeToApi,
  formatEndpoint,
  type GraphNode,
  graphTarget,
  loadOrFail,
  requireArray,
  type StoredEdge,
} from '@/app/_authed/(apps)/_server/graph-actions/graph-target'
import { nodeTypeView, readEnumCases, readNodeTypes } from '@/app/_authed/(apps)/_server/graph-actions/node-types'
import { nodeRedactor } from '@/app/_authed/(apps)/_server/graph-actions/redact-node-data'
import type { HostAppAction } from '@/app/_authed/(apps)/_server/host-apps'
import { declaredHandlesOf } from '@/app/_authed/(extension-runtime)/_declared-handles'
import { enumCasesOfManifests } from '@/app/_authed/(extension-runtime)/_enum-types'
import { withAbsolutePositions, withLevels } from '@/app/_authed/(extension-runtime)/_frame-tree'
import { loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import { withCheckedErrors } from '@/app/_authed/(extension-runtime)/_server/node-data-validation'
import {
  buildNodeTypeHandles,
  expandDynamicHandles,
  findDockerExtensionId,
} from '@/app/_authed/(extension-runtime)/_server/node-handles'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { fail } from '@/app/_authed/(mcp)/_server/tool-refusal'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

/**
 * The graph with each node's `data` and `check` errors as its type's
 * validator and check find them now, for a read that shows node data. The
 * stored ones are set where the graph's live document loads and after each
 * write, and a read loads neither: a graph nobody has opened or written since
 * its data was stored, or since its validator or check changed, holds stale
 * ones. Nothing is stored.
 */
async function loadWithCheckedErrors(address: string): Promise<GraphData> {
  const { graph } = await loadOrFail(address)
  return withAbsolute(await withCheckedErrors(graph))
}

/**
 * `graph` as agents read it: every position absolute, where the node is drawn
 * on its level's canvas, and each node inside a subgraph carrying it as
 * `subgraph` (see `_frame-tree.ts`).
 */
function withAbsolute(graph: GraphData): GraphData {
  return {
    ...graph,
    nodes: withLevels(withAbsolutePositions(graph.nodes as unknown as GraphNode[])) as unknown as GraphData['nodes'],
  }
}

const SUBGRAPH_PARAM = {
  type: ['string', 'null'],
  description:
    'Only the nodes on one level: a subgraph node id for the nodes on its canvas, or null for the top level. Left out, every node of the graph, inside subgraphs too.',
}

/** The level a read's `subgraph` parameter keeps: undefined for every node. */
function readLevel(value: unknown): { level: string | undefined } | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return { level: undefined }
  }
  if (typeof value === 'string' && value !== '') {
    return { level: value }
  }
  fail(-32602, `"subgraph" must be a subgraph node id or null: got ${JSON.stringify(value)}`)
}

/** Whether `node`, as `withAbsolute` reads it, is on the level `wanted` keeps. */
function onLevel(node: GraphNode & { subgraph?: string }, wanted: { level: string | undefined } | undefined): boolean {
  return wanted === undefined || node.subgraph === wanted.level
}

async function buildTypeNameMap(): Promise<Map<string, string>> {
  const manifests = await loadAllManifests()
  const map = new Map<string, string>()
  for (const manifest of manifests) {
    for (const node of manifest.nodes ?? []) {
      map.set(node.type, node.name)
    }
  }
  return map
}

interface TypeHandlesContext {
  typeHandles: Map<string, ExtensionHandle[]>
  enumCasesOf: EnumCasesOf
  // Resolved once here rather than per node inside the expansion.
  dockerExtensionId: string | null
}

async function buildTypeHandlesMap(): Promise<TypeHandlesContext> {
  const manifests = await loadAllManifests()
  const byType = buildNodeTypeHandles(manifests)
  return {
    typeHandles: new Map(Array.from(byType, ([type, entry]) => [type, entry.handles])),
    enumCasesOf: enumCasesOfManifests(manifests),
    dockerExtensionId: findDockerExtensionId(manifests),
  }
}

interface NodeHandlesView {
  input: Record<string, string | null>
  output: Record<string, string[]>
  /** The type each input that takes several types has now, by handle id; absent when none does. */
  types?: Record<string, string>
}

async function nodeHandles(
  node: GraphNode,
  edges: StoredEdge[],
  { typeHandles, enumCasesOf, dockerExtensionId }: TypeHandlesContext,
): Promise<NodeHandlesView> {
  const input: Record<string, string | null> = {}
  const output: Record<string, string[]> = {}
  const types: Record<string, string> = {}
  const declared = declaredHandlesOf(node, (type) => typeHandles.get(type) ?? [], enumCasesOf)
  for (const h of declared) {
    if (h.role === 'target') {
      input[h.id] = null
      if (takesSeveralTypes(h)) {
        types[h.id] = h.handleType
      }
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
      // The edge that feeds the handle is the first one into it (see `feedingEdges`).
      input[edge.targetHandle] ??= formatEndpoint(edge.source, edge.sourceHandle)
      continue
    }
    if (edge.source === node.id && edge.sourceHandle) {
      const list = output[edge.sourceHandle] ?? []
      list.push(formatEndpoint(edge.target, edge.targetHandle))
      output[edge.sourceHandle] = list
    }
  }
  return { input, output, ...(Object.keys(types).length > 0 ? { types } : {}) }
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
    description:
      'List all nodes in this graph, those inside subgraphs included. Returns a compact array of `{ id, name, parentId?, subgraph? }` entries; `parentId` is the frame (such as a Section) or subgraph the node is inside, and `subgraph` the nearest subgraph it is in, the canvas it is drawn on. `subgraph` narrows the list to one level.',
    inputSchema: { type: 'object', properties: { subgraph: SUBGRAPH_PARAM } },
    run: async (ctx, params) => {
      const wanted = readLevel(params.subgraph)
      const { address } = await graphTarget(ctx)
      const { graph } = await loadOrFail(address)
      const typeNames = await buildTypeNameMap()
      const entries = withLevels(graph.nodes as unknown as GraphNode[])
        .filter((node) => onLevel(node, wanted))
        .map((node) => ({
          id: node.id,
          name: nodeName(node, typeNames),
          ...(node.parentId ? { parentId: node.parentId } : {}),
          ...(node.subgraph ? { subgraph: node.subgraph } : {}),
        }))
      return JSON.stringify(entries)
    },
  },
  {
    id: 'findNodes',
    description:
      'Find nodes in this graph whose name, type, or data fields match any of the given glob patterns (case-insensitive). Use `*` and `?` wildcards. A type is `<owner>.<extension>.<type>`, e.g. "acme.widgets.gauge", so "*.gauge" finds that type from any extension. Data is matched as getNodes shows it, with typed credentials as `[redacted]`. Searches every level, inside subgraphs too, unless `subgraph` names one; a node inside a subgraph comes with `subgraph`, the nearest one it is in, and its `position` is on that subgraph\'s canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns (e.g. ["*server*", "WSL"]).',
          minItems: 1,
        },
        subgraph: SUBGRAPH_PARAM,
      },
      required: ['patterns'],
    },
    run: async (ctx, params) => {
      const patterns = requireArray<string>(params.patterns, 'patterns')
      const wanted = readLevel(params.subgraph)
      const { address } = await graphTarget(ctx)
      const graph = await loadWithCheckedErrors(address)
      const typeNames = await buildTypeNameMap()
      const regexes = patterns.map((p) => ({ pattern: p, regex: globToRegex(p) }))
      // Matched against what a read may show, so a pattern cannot find a
      // hidden credential by guessing at it.
      const redactNode = await nodeRedactor(graph.nodes)
      const results: Record<string, unknown>[] = []
      for (const n of graph.nodes) {
        if (!onLevel(n as unknown as GraphNode, wanted)) {
          continue
        }
        const node = redactNode(n as unknown as GraphNode) as GraphNode & { subgraph?: string }
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
        if (node.parentId) {
          entry.parentId = node.parentId
        }
        if (node.subgraph) {
          entry.subgraph = node.subgraph
        }
        if (node.style?.width !== undefined || node.style?.height !== undefined) {
          entry.size = { width: node.style.width, height: node.style.height }
        }
        entry.matches = matches
        results.push(entry)
      }
      return JSON.stringify(results)
    },
  },
  {
    id: 'getNodes',
    description:
      "Get one or more nodes of this graph by ID. Returns `{ found: Node[], missing: string[] }`. Each found node includes a `handles: { input, output }` map: `input[handleId]` is `\"node-id/handle-id\"` for the connected source or `null`, `output[handleId]` is an array of connected target endpoints (empty if unconnected). Dynamic source handles are expanded to live ids (e.g. an application node exposes one `instance-terminal-<container name>` per replica, whether or not its container runs). A credential typed into a node (a password or key field, a credential-named header or variable, a URL password, a stored secret's value) reads as `[redacted]`; a value taken from a secret reads as `secret:<NAME>`. `position` is where the node is drawn on its canvas, and `parentId` the frame (such as a Section) or subgraph it is inside, when it is. A node inside a subgraph carries `subgraph`, the nearest one it is in, and its `position` is on that subgraph's canvas. A subgraph's handles are its ports, from its `data.ports`: `in-<port>` and `out-<port>`. `handles` shows the edges as stored, so a node fed through a port reads `input[h] = \"<subgraph>/in-<port>\"`. Values typed into a node's text, number and boolean inputs are in `data.inputs`, by handle id; an input with an edge reads the edge's value instead, and keeps the typed one for when the edge goes. An input that takes several types (a Switch's `condition`, a Select's `true` and `false`) has the type connected into it: `handles.types[handleId]` is the type it has now, from the node's `data.inputTypes` (by type group), which connecting sets and which is never written by hand.",
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
      const graph = await loadWithCheckedErrors(address)
      const typeHandles = await buildTypeHandlesMap()
      const redactNode = await nodeRedactor(graph.nodes)
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
          // Handles are read from the stored node: a dynamic handle id can depend on its data.
          found.push({ ...redactNode(node), handles: await nodeHandles(node, edges, typeHandles) })
          continue
        }
        missing.push(id)
      }
      return JSON.stringify({ found, missing })
    },
  },
  {
    id: 'listNodeTypes',
    description:
      "List the node types createNodes accepts: every type an installed extension provides. Each entry is `{ type, label, extension, extensionName, category?, description?, handles: { input, output } }`; `type` is what createNodes takes, and each handle is `{ id, handleType, label?, dynamic?, multiple?, runtime? }`, where a dynamic handle's id is the prefix of ids a node makes at run time (connect with connectNodes as `<node-id>/<handle-id>`). An input takes one edge (connecting another replaces it) unless it is `multiple`; an output takes any number. Plain values travel on three handle types: `builtin.core.string` (text), `builtin.core.number` and `builtin.core.boolean`; a JSON object travels on `builtin.core.object`, which connects only to an object input, takes no typed value and is read with a Get node. A handle of an enum type, which an extension declares with its cases, carries `cases` (`{ value, label? }`, in order): its value is one case's `value`, typed as that text; it connects to the same enum or to a text input, and a Switch on it has one output per case, `case-<value>`, then `exec-default`. An output marked `runtime: true` (an API Route's body, an Event's payload, an Agent Tool's args, a Call Action's result and error) has a value only while its node's run dispatches: outside one, what it feeds reads nothing and is listed under `__awaitingRun` (and `__unresolvedInputs`) in getNodes. An input of one of the three plain types or of an enum takes a value typed into the node while no edge feeds it, stored at `data.inputs.<handle id>`; its handle also shows what may be typed: `default` (read while nothing is typed or wired), `integer`, `min`, `max`, `step`, `options` (`{ value, label? }`, the only text it takes), `multiline`, or `inline: false` for an input that must be wired. `query` keeps the types whose type, label, extension name, category or description contains it (case-insensitive).",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to filter by, e.g. "docker" or "terminal".' },
      },
    },
    run: async (_ctx, params) => {
      const query = typeof params.query === 'string' ? params.query.trim().toLowerCase() : ''
      const enumCasesOf = await readEnumCases()
      const views = [...(await readNodeTypes()).values()]
        .map((entry) => nodeTypeView(entry, enumCasesOf))
        .sort((a, b) => a.type.localeCompare(b.type))
      const matching = query
        ? views.filter((view) =>
            [view.type, view.label, view.extensionName, view.category, view.description].some((field) =>
              field?.toLowerCase().includes(query),
            ),
          )
        : views
      return JSON.stringify(matching)
    },
  },
  {
    id: 'listEdges',
    description:
      'List all edges in this graph, as they are stored and drawn: a value wired into a subgraph is an edge to its port handle outside and one from the same handle inside.',
    inputSchema: { type: 'object', properties: {} },
    run: async (ctx) => {
      const { address } = await graphTarget(ctx)
      const { graph } = await loadOrFail(address)
      const edges = graph.edges.map((e) => edgeToApi(e as StoredEdge))
      return JSON.stringify(edges)
    },
  },
]
