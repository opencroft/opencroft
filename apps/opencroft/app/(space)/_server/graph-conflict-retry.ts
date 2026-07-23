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

import { loadSpaceGraph, saveSpaceGraph } from '@/app/(space)/_server/actions'
import { GraphConflictError, getSpacesRegistry } from '@/app/(space)/_server/store'
import type { GraphData } from '@/app/(space)/_server/types'
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
    const { graph, updatedAt } = await load(slug)
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
