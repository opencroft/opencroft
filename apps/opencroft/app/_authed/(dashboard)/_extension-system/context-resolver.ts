import type { Edge, Node } from '@xyflow/react'

import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { feedingEdges } from '@/app/_authed/(extension-runtime)/_input-edges'
import { findExtensionHandle, type ResolvedContext } from '@/app/_authed/(extension-runtime)/_types'

export interface GraphSnapshot {
  nodes: Node[]
  edges: Edge[]
}

interface SourceNode {
  id: string
  type?: string
  data?: Record<string, unknown>
}

/**
 * The context `source` exposes on its `sourceHandleId` output, or null when
 * its extension exposes nothing there. Reads the page's copy of the source
 * node and of the graph, so it follows wiring and edits made on the open
 * canvas — including the source's own inputs, which `exposeOutput` is handed
 * as `contexts` because an output can be built from them.
 */
export function resolveSourceContext(
  source: SourceNode,
  sourceHandleId: string,
  graph: GraphSnapshot,
): ResolvedContext | null {
  return resolveSource(source, sourceHandleId, graph, new Set())
}

/**
 * Every wired input of `nodeId` that resolves, keyed by target handle id —
 * the canvas's own counterpart of the `__resolvedContexts` the server writes
 * into node data on save, and fed by the same edge (see `feedingEdges`).
 */
export function resolveInputContexts(nodeId: string, graph: GraphSnapshot): Record<string, ResolvedContext> {
  return resolveInputs(nodeId, graph, new Set())
}

/**
 * Whether two resolved contexts carry the same content. Plain objects and
 * arrays compare by their entries; anything else an extension exposes — a
 * stream, a Blob, a function — compares by identity, since it is live and a
 * copy of it is not the same thing.
 */
export function sameContext(a: ResolvedContext | null, b: ResolvedContext | null): boolean {
  return sameValue(a, b)
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
    )
  }
  return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// `resolving` holds the nodes whose inputs are being resolved further up this
// chain. A node met again is a wiring cycle: it contributes no inputs there,
// so the chain ends instead of recursing forever.
function resolveSource(
  source: SourceNode,
  sourceHandleId: string,
  graph: GraphSnapshot,
  resolving: Set<string>,
): ResolvedContext | null {
  if (!source.type || !source.data) {
    return null
  }
  const resolved = extensionRegistry.resolveNode(source.type)
  if (!resolved?.exposeOutput) {
    return null
  }
  const handleDef = findExtensionHandle(resolved.handles, sourceHandleId, 'source')
  if (!handleDef) {
    return null
  }
  const contexts = resolveInputs(source.id, graph, resolving)
  const value = resolved.exposeOutput(sourceHandleId, source.data, source.id, contexts)
  if (value === undefined || value === null) {
    return null
  }
  return {
    sourceNodeId: source.id,
    sourceHandleId,
    type: handleDef.handleType,
    value,
  }
}

function resolveInputs(nodeId: string, graph: GraphSnapshot, resolving: Set<string>): Record<string, ResolvedContext> {
  const result: Record<string, ResolvedContext> = {}
  if (resolving.has(nodeId)) {
    return result
  }
  const inner = new Set(resolving).add(nodeId)
  for (const edge of feedingEdges(graph.edges)) {
    if (edge.target !== nodeId || !edge.sourceHandle) {
      continue
    }
    const source = graph.nodes.find((n) => n.id === edge.source)
    const ctx = source ? resolveSource(source, edge.sourceHandle, graph, inner) : null
    if (ctx) {
      result[edge.targetHandle] = ctx
    }
  }
  return result
}
