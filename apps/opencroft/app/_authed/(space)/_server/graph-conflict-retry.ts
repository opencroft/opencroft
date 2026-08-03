// Shared optimistic-concurrency retry helper for space-graph writes (see
// its callers). Any caller mutating one narrow, well-defined
// piece of a graph (one node's data, a handful of edges) can use this instead
// of a raw save: on a conflict it reloads the graph and re-runs `mutate`
// against the fresh state, so it's a reapply, not a blind replay.
//
// Two load/save pairs are available:
//  - loadViaAction/saveViaAction (the default): go through the TanStack Start
//    server functions in actions.ts — for callers already running inside a
//    real request (MCP tool calls).
//  - loadGraphPlain/saveGraphPlain: bypass those server functions entirely —
//    for callers with NO request context at all, e.g. a background scheduler
//    tick (see exec-dispatch.ts's invokeExtensionActionImpl/dispatchNodeActionImpl
//    for the same pattern and why it's needed).

import { loadSpaceGraph, saveSpaceGraph } from '@/app/_authed/(space)/_server/actions'
import { GraphConflictError, getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { toastStore } from '@/lib/toast-store'

export { GraphConflictError }

export const MAX_GRAPH_CONFLICT_RETRIES = 3

async function loadViaAction(slug: string): Promise<{ graph: GraphData; updatedAt: string }> {
  const result = await loadSpaceGraph({ data: slug })
  if (!result) {
    throw new Error(`Space not found: ${slug}`)
  }
  return result
}

async function saveViaAction(slug: string, graph: GraphData, expectedUpdatedAt: string): Promise<unknown> {
  return saveSpaceGraph({ data: { slug, graph, expectedUpdatedAt } })
}

export async function loadGraphPlain(slug: string): Promise<{ graph: GraphData; updatedAt: string }> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const space = registry.getBySlug(slug)
  if (!space) {
    throw new Error(`Space not found: ${slug}`)
  }
  return { graph: space.graph, updatedAt: space.updatedAt.toISOString() }
}

export async function saveGraphPlain(slug: string, graph: GraphData, expectedUpdatedAt: string): Promise<unknown> {
  const runtime = await getSpacesRegistry().saveGraph(slug, graph, expectedUpdatedAt)
  // Single broadcast point, mirroring saveSpaceGraph's action (actions.ts) — any
  // open tab resyncs before it can save over this write.
  toastStore.broadcast({ type: 'graph_updated', spaceId: slug })
  return runtime
}

export async function withGraphConflictRetry<T>(
  slug: string,
  mutate: (graph: GraphData, updatedAt: string) => Promise<T> | T,
  {
    load = loadViaAction,
    save = saveViaAction,
  }: {
    load?: (slug: string) => Promise<{ graph: GraphData; updatedAt: string }>
    save?: (slug: string, graph: GraphData, expectedUpdatedAt: string) => Promise<unknown>
  } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const { graph: loaded, updatedAt } = await load(slug)
    // Both load implementations return the space registry's live, shared graph
    // object by reference (not a copy) — loadGraphPlain directly, loadViaAction
    // because calling a createServerFn in-process returns its raw handler
    // result with no serialization boundary. Mutating that object before
    // `save` is known to succeed means a failed attempt's mutation is never
    // rolled back: it stays on the live object, and the *next* attempt's
    // `load` returns that same already-dirty object, so a retry compounds
    // instead of reapplying cleanly (concretely: two entries appended for one
    // scheduler fire when a concurrent canvas save raced it).
    // Clone before handing it to `mutate` so every attempt starts from an
    // isolated copy of the last known-good state.
    const graph = structuredClone(loaded)
    const result = await mutate(graph, updatedAt)
    try {
      await save(slug, graph, updatedAt)
      return result
    } catch (err) {
      if (!(err instanceof GraphConflictError) || attempt >= MAX_GRAPH_CONFLICT_RETRIES) {
        throw err
      }
    }
  }
}
