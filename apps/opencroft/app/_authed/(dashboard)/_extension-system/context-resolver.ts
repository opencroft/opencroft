import { type ResolvedInputEntry, withWiredInputs } from '@opencroft/core/values'
import type { Edge, Node } from '@xyflow/react'

import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { sourceHandleOf } from '@/app/_authed/(extension-runtime)/_declared-handles'
import { feedingEdges } from '@/app/_authed/(extension-runtime)/_input-edges'
import type { ResolvedContext } from '@/app/_authed/(extension-runtime)/_types'
import { wiredEdges } from '@/app/_authed/(extension-runtime)/_wired-edges'

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
 * as `contexts`, and in its data as the server's resolver writes them,
 * because an output can be built from them.
 */
export function resolveSourceContext(
  source: SourceNode,
  sourceHandleId: string,
  graph: GraphSnapshot,
): ResolvedContext | null {
  const resolved = resolveSource(source, sourceHandleId, graph, new Set())
  return resolved === AWAITING_RUN ? null : resolved
}

// What a source that exposes nothing because nothing runs resolves to: the
// canvas never has a run, so a run-time output (`runtime: true`) is always
// this, and so is a source that exposes nothing while one of its own inputs
// is. The server's resolver tells the two apart the same way.
const AWAITING_RUN = 'awaiting-run'

/**
 * Every wired input of `nodeId` that resolves, keyed by target handle id —
 * the canvas's own counterpart of the `__resolvedContexts` the server writes
 * into node data on save, and fed by the same edge (see `feedingEdges`).
 */
export function resolveInputContexts(nodeId: string, graph: GraphSnapshot): Record<string, ResolvedContext> {
  return resolveInputs(nodeId, graph, new Set()).contexts
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
): ResolvedContext | typeof AWAITING_RUN | null {
  if (!source.type || !source.data) {
    return null
  }
  const resolved = extensionRegistry.resolveNode(source.type)
  if (!resolved?.exposeOutput) {
    return null
  }
  const handleDef = sourceHandleOf(
    source,
    sourceHandleId,
    (type) => extensionRegistry.resolveNode(type)?.handles ?? [],
    extensionRegistry.enumCasesOf,
  )
  if (!handleDef) {
    return null
  }
  const { contexts, unresolved, awaitingRun } = resolveInputs(source.id, graph, resolving)
  // The source's data carries its inputs as the open page has them wired, in
  // the shape the server's resolver writes, not as the server last stored them.
  const data = withWiredInputs(source.data, entriesOf(contexts), unresolved, awaitingRun)
  const value = resolved.exposeOutput(sourceHandleId, data, source.id, contexts)
  if (value === undefined || value === null) {
    return handleDef.runtime === true || awaitingRun.length > 0 ? AWAITING_RUN : null
  }
  return {
    sourceNodeId: source.id,
    sourceHandleId,
    type: handleDef.handleType,
    value,
  }
}

function entriesOf(contexts: Record<string, ResolvedContext>): Record<string, ResolvedInputEntry> {
  return Object.fromEntries(
    Object.entries(contexts).map(([handleId, ctx]) => [
      handleId,
      { sourceNodeId: ctx.sourceNodeId, sourceHandleId: ctx.sourceHandleId, handleType: ctx.type, value: ctx.value },
    ]),
  )
}

/**
 * `node`'s data with its wired inputs as the open canvas has them (see
 * `resolved-inputs.ts` in `@opencroft/core/values`): what a card reads to show what the node computes now.
 */
export function liveNodeData(node: SourceNode, graph: GraphSnapshot): Record<string, unknown> {
  const { contexts, unresolved, awaitingRun } = resolveInputs(node.id, graph, new Set())
  return withWiredInputs(node.data ?? {}, entriesOf(contexts), unresolved, awaitingRun)
}

// A wired input whose source exposes nothing is in `unresolved`, as the
// server lists it under `__unresolvedInputs`, and also in `awaitingRun` when
// that nothing waits for a run, as the server lists it under `__awaitingRun`.
function resolveInputs(
  nodeId: string,
  graph: GraphSnapshot,
  resolving: Set<string>,
): { contexts: Record<string, ResolvedContext>; unresolved: string[]; awaitingRun: string[] } {
  const contexts: Record<string, ResolvedContext> = {}
  const unresolved: string[] = []
  const awaitingRun: string[] = []
  if (resolving.has(nodeId)) {
    return { contexts, unresolved, awaitingRun }
  }
  const inner = new Set(resolving).add(nodeId)
  // Through subgraph ports to the real sources, as the server resolves them.
  for (const edge of feedingEdges(wiredEdges(graph))) {
    if (edge.target !== nodeId || !edge.sourceHandle) {
      continue
    }
    const source = graph.nodes.find((n) => n.id === edge.source)
    const ctx = source ? resolveSource(source, edge.sourceHandle, graph, inner) : null
    if (ctx === AWAITING_RUN) {
      unresolved.push(edge.targetHandle)
      awaitingRun.push(edge.targetHandle)
    } else if (ctx) {
      contexts[edge.targetHandle] = ctx
    } else {
      unresolved.push(edge.targetHandle)
    }
  }
  return { contexts, unresolved, awaitingRun }
}
