// Shared execution-context ("exec-out") dispatcher.
//
// Every producer of an execution-context output (API Route, Event, Agent
// Tool) used to hardcode its own edge-walk + script-language gate + handler
// invocation. This module is the single place that does it: resolve every
// edge connected to a producer's exec-out handle, dispatch each connected
// target through whichever mechanism it supports, and report one primary
// result (stable across graph re-saves) plus the outcome of every target.
//
// Target resolution order, per connected node:
//   1. Its owning extension exports a `nodeActions[typeId].handle` action
//      (the same mechanism gitea-handler and other extensions already use
//      for Agent Tool calls) -> dispatched via `dispatchNodeAction`.
//   2. It is a built-in script node (`data.language` is 'python' or 'node')
//      -> dispatched via the `builtin/core` extension's `handler.run` action,
//      unchanged from today's per-producer behavior.
//   3. Neither -> the same "Unsupported handler language" error producers
//      have always returned, scoped to that one target.

import { invokeExtensionActionImpl } from '@/app/_authed/(extension-runtime)/_server/extension-action-impl'
import { getExtensionModule, loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import { dispatchNodeActionImpl } from '@/app/_authed/(extension-runtime)/_server/node-actions-impl'
import { getStream } from '@/app/_authed/(extension-runtime)/_server/stream'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { secrets } from '@/server/secrets'

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface ExecDispatchNode {
  id: string
  type?: string
  data?: Record<string, unknown>
}

export interface ExecDispatchEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

/** Normalized result shape shared by every dispatch path — a strict superset
 *  of the `{ body }`-only contract extension `handle` actions returned
 *  before this change, so existing extension handlers keep working. */
export interface ExecDispatchResult {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  error?: string
  logs?: string
}

export interface ExecDispatchTargetOutcome {
  nodeId: string
  primary: boolean
  result: ExecDispatchResult
}

export interface ExecDispatchSummary {
  /** The chosen primary target's result — maps 1:1 onto what a single-target
   *  producer returned before broadcast support existed. */
  primary: ExecDispatchResult
  /** One entry per connected target, primary included. */
  targets: ExecDispatchTargetOutcome[]
}

// ═══════════════════════════════════════════════════════════════════
// Pure helpers (unit tested directly — see exec-dispatch.test.ts)
// ═══════════════════════════════════════════════════════════════════

/** Edge ids never change after creation, unlike array order (a canvas
 *  re-save persists the whole in-memory graph and can reorder the edges
 *  array). Sorting by id keeps the primary-target pick stable across saves. */
export function pickPrimaryEdge<T extends { id: string }>(edges: T[]): T | undefined {
  if (edges.length === 0) {
    return undefined
  }
  return [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
}

export function unsupportedHandlerError(language: string | undefined): string {
  return `Unsupported handler language: ${language ?? 'none'}. Only Python and Node.js scripts support ExecutionContext.`
}

/** Parse a script node's `env` field: one `KEY=VALUE` pair per line. */
export function parseEnvBlock(text: string | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  const lines = (text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq > 0) {
      env[line.slice(0, eq).trim()] = line.slice(eq + 1)
    }
  }
  return env
}

/** Parse a script node's `secrets` field: one Secrets Store key name per line. */
export function parseNameLines(text: string | undefined): string[] {
  return (text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

// ═══════════════════════════════════════════════════════════════════
// Graph lookup
// ═══════════════════════════════════════════════════════════════════

async function findSpaceWithNode(
  nodeId: string,
): Promise<{ slug: string; nodes: ExecDispatchNode[]; edges: ExecDispatchEdge[] } | null> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const ref = registry.findByNode(nodeId)
  if (!ref) {
    return null
  }
  // The node's whole SPACE, across its graphs: exec wiring is space-scoped,
  // like every other reachability rule here.
  const graphs = [...ref.space.graphs.values()]
  return {
    slug: ref.space.slug,
    nodes: graphs.flatMap((g) => g.graph.nodes) as unknown as ExecDispatchNode[],
    edges: graphs.flatMap((g) => g.graph.edges) as unknown as ExecDispatchEdge[],
  }
}

async function hasHandleAction(typeId: string | undefined): Promise<boolean> {
  if (!typeId) {
    return false
  }
  const manifests = await loadAllManifests()
  const owning = manifests.find((m) => m.nodes?.some((n) => n.typeId === typeId))
  if (!owning) {
    return false
  }
  const mod = await getExtensionModule(owning.id)
  return Boolean(mod.nodeActions?.[typeId]?.handle)
}

// ═══════════════════════════════════════════════════════════════════
// Per-target dispatch
// ═══════════════════════════════════════════════════════════════════

async function resolveEnv(node: ExecDispatchNode): Promise<{ env: Record<string, string>; error?: string }> {
  const data = node.data ?? {}
  const env = parseEnvBlock(data.env as string | undefined)
  for (const name of parseNameLines(data.secrets as string | undefined)) {
    const value = await secrets.resolve(name)
    if (value === null) {
      return { env, error: `secret "${name}" not found in any Secrets Store.` }
    }
    env[name] = value
  }
  return { env }
}

async function dispatchToTarget(
  spaceSlug: string,
  node: ExecDispatchNode,
  event: unknown,
): Promise<ExecDispatchResult> {
  if (await hasHandleAction(node.type)) {
    try {
      const result = (await dispatchNodeActionImpl({
        nodeId: node.id,
        actionId: 'handle',
        params: event as Record<string, unknown>,
      })) as ExecDispatchResult | undefined
      return result ?? {}
    } catch (err) {
      return { status: 500, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const data = node.data ?? {}
  const language = data.language as string | undefined
  if (language !== 'python' && language !== 'node') {
    return { status: 400, error: unsupportedHandlerError(language) }
  }

  const { env, error: envError } = await resolveEnv(node)
  if (envError) {
    return { status: 500, error: envError }
  }

  const resolvedContexts = data.__resolvedContexts as Record<string, { value?: Record<string, unknown> }> | undefined
  const context = resolvedContexts?.['ctx-in']?.value ?? { type: 'local' }

  let result: ExecDispatchResult
  try {
    result = ((await invokeExtensionActionImpl({
      extensionId: 'builtin/core',
      actionName: 'handler.run',
      args: [{ script: (data.script as string) ?? '', language, context, event, env }],
    })) ?? {}) as ExecDispatchResult
  } catch (err) {
    return { status: 500, error: err instanceof Error ? err.message : String(err) }
  }

  const stream = getStream<{ text: string; final: boolean }>(spaceSlug, node.id, 'stdout-out')
  if (result.logs) {
    stream.broadcast({ text: result.logs, final: false })
  }
  stream.broadcast({ text: '', final: true })

  return result
}

// ═══════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════

export interface ExecDispatchParams {
  sourceNodeId: string
  sourceHandleId: string
  event: unknown
}

/** No connected target at all — producers turn this into their own
 *  "no handler" response (502 for API Route, a tool-error string for Agent
 *  Tool, a thrown Error for Event). */
export class NoExecTargetError extends Error {
  constructor(sourceNodeId: string, sourceHandleId: string) {
    super(`No target connected to ${sourceNodeId}/${sourceHandleId}`)
    this.name = 'NoExecTargetError'
  }
}

export async function dispatchExecutionContext(params: ExecDispatchParams): Promise<ExecDispatchSummary> {
  const { sourceNodeId, sourceHandleId, event } = params

  const found = await findSpaceWithNode(sourceNodeId)
  if (!found) {
    throw new Error(`Node not found: ${sourceNodeId}`)
  }

  const connectedEdges = found.edges.filter((e) => e.source === sourceNodeId && e.sourceHandle === sourceHandleId)
  if (connectedEdges.length === 0) {
    throw new NoExecTargetError(sourceNodeId, sourceHandleId)
  }

  const primaryEdge = pickPrimaryEdge(connectedEdges)!
  const nodesById = new Map(found.nodes.map((n) => [n.id, n]))

  const logStream = getStream<{ text: string; final: boolean }>(found.slug, sourceNodeId, 'stdout-out')
  if (connectedEdges.length > 1) {
    logStream.broadcast({ text: `[exec-dispatch] primary target: ${primaryEdge.target}\n`, final: false })
  }

  const settled = await Promise.allSettled(
    connectedEdges.map(async (edge) => {
      const node = nodesById.get(edge.target)
      const result = node
        ? await dispatchToTarget(found.slug, node, event)
        : { status: 500, error: `Handler node not found: ${edge.target}` }
      return { edge, result }
    }),
  )

  const targets: ExecDispatchTargetOutcome[] = settled.map((outcome, i) => {
    const edge = connectedEdges[i]
    const primary = edge.id === primaryEdge.id
    if (outcome.status === 'fulfilled') {
      if (!primary && outcome.value.result.error) {
        logStream.broadcast({
          text: `[exec-dispatch] target ${edge.target} failed: ${outcome.value.result.error}\n`,
          final: false,
        })
      }
      return { nodeId: edge.target, primary, result: outcome.value.result }
    }
    const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
    if (!primary) {
      logStream.broadcast({ text: `[exec-dispatch] target ${edge.target} failed: ${message}\n`, final: false })
    }
    return { nodeId: edge.target, primary, result: { status: 500, error: message } }
  })

  const primary = targets.find((t) => t.primary)!.result
  return { primary, targets }
}
