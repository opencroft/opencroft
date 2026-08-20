// The actual space-registry logic, deliberately separate from actions.ts.
//
// TWO REASONS THIS FILE EXISTS. Both have already caused a real bug, so
// neither is theoretical:
//
// 1. CLIENT BUNDLE. actions.ts is reachable from client code (canvas UI and
//    spaces-table import its server functions). The client transform only
//    replaces `createServerFn(...).handler(...)` expressions with RPC stubs —
//    a plain exported function in that same file gets no stub and ships its
//    server-only imports straight to the browser. That is the acp.ts leak
//    (see acp.ts/acp-impl.ts, token-actions.ts/token-actions-impl.ts).
//
// 2. IN-PROCESS CALLERS WITH NO SESSION. (mcp)/_server/tools.ts and
//    graph-conflict-retry.ts call these operations directly, in-process, to
//    serve MCP tool calls. /api/mcp is a bearer-token surface and carries no
//    session cookie by design. A session check placed in
//    the only implementation therefore throws for every agent tool. That is
//    exactly what happened: gating listSpaces/loadSpaceGraph/saveSpaceGraph
//    inline broke list/read tools AND — via withGraphConflictRetry's default
//    load/save — all seven MCP graph-write tools.
//
// So: EVERY operation lives here as a plain, session-free `*Impl`, and every
// export in actions.ts is a thin createServerFn wrapper that checks the
// session and delegates. One rule, no per-function judgement about which
// pattern applies, and an impl already available the day something new needs
// to call one of these in-process.
//
// Nothing in this file may be re-exported from actions.ts as a plain
// function — that would reinstate reason 1.

import { resolveGraphContexts } from '@/app/_authed/(extension-runtime)/_server/graph-context-resolver'
import type { GraphSnapshot } from '@/app/_authed/(extension-runtime)/_server/host'
import { slugify, uniqueSlug } from '@/app/_authed/(space)/_server/slug'
import { getSpacesRegistry, type SpaceRuntime, SpaceSlugTakenError } from '@/app/_authed/(space)/_server/store'
import {
  DEFAULT_SPACE_SLUG,
  type GraphData,
  type SpaceExport,
  type SpaceSummary,
} from '@/app/_authed/(space)/_server/types'
import { toastStore } from '@/lib/toast-store'

export async function registry() {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  return r
}

export function toSummary(runtime: SpaceRuntime): SpaceSummary {
  return {
    id: runtime.id,
    slug: runtime.slug,
    name: runtime.name,
    pinned: runtime.pinned,
    createdAt: runtime.createdAt.toISOString(),
    updatedAt: runtime.updatedAt.toISOString(),
  }
}

async function resolveGraph(graph: GraphData): Promise<GraphData> {
  const snapshot: GraphSnapshot = {
    nodes: graph.nodes as unknown as GraphSnapshot['nodes'],
    edges: graph.edges as unknown as GraphSnapshot['edges'],
  }
  const resolved = await resolveGraphContexts(snapshot)
  return {
    nodes: resolved.nodes as unknown as GraphData['nodes'],
    edges: resolved.edges as unknown as GraphData['edges'],
  }
}

export async function listSpacesImpl(): Promise<SpaceSummary[]> {
  const r = await registry()
  return r.list()
}

export async function loadSpaceGraphImpl(slug: string): Promise<{ graph: GraphData; updatedAt: string } | null> {
  const r = await registry()
  const space = r.getBySlug(slug)
  if (!space) {
    return null
  }
  return { graph: space.graph, updatedAt: space.updatedAt.toISOString() }
}

export async function saveSpaceGraphImpl(data: {
  slug: string
  graph: GraphData
  expectedUpdatedAt?: string
}): Promise<{ updatedAt: string }> {
  const r = await registry()
  const resolved = await resolveGraph(data.graph)
  const runtime = await r.saveGraph(data.slug, resolved, data.expectedUpdatedAt)
  if (!runtime) {
    throw new Error(`Space not found: ${data.slug}`)
  }
  // Single broadcast point for every graph mutation (canvas autosave and
  // MCP node/edge tools alike) so any other open tab resyncs instead of
  // later overwriting this write with a stale snapshot.
  toastStore.broadcast({ type: 'graph_updated', spaceId: data.slug })
  return { updatedAt: runtime.updatedAt.toISOString() }
}

export async function createSpaceImpl(name: string): Promise<SpaceSummary> {
  const r = await registry()
  const trimmed = name.trim() || 'Space'
  const existing = new Set(r.list().map((s) => s.slug))
  const slug = uniqueSlug(slugify(trimmed), existing)
  const runtime = await r.create(trimmed, slug, { nodes: [], edges: [] })
  return toSummary(runtime)
}

/**
 * Renamed, or refused with a code.
 *
 * A REFUSAL IS RETURNED, NOT THROWN, for the reason the group-chat writes
 * already document: a thrown error does not survive `createServerFn` intact --
 * it crosses as `$TSR/Error` carrying `message` and nothing else, so a client
 * branching on a code silently falls through to whatever its fallback is. As
 * data, the code arrives whole and the wording stays a client-side concern.
 *
 * `not-found` replaces the bare `null` this used to answer with, so the two
 * outcomes a caller must tell apart are two members of one type rather than a
 * null and a throw.
 */
export type RenameSpaceResult = { ok: true; space: SpaceSummary } | { ok: false; code: 'not-found' | 'slug-taken' }

export async function renameSpaceImpl(data: { slug: string; name: string }): Promise<RenameSpaceResult> {
  const r = await registry()
  try {
    const runtime = await r.rename(data.slug, data.name.trim() || 'Space')
    return runtime ? { ok: true, space: toSummary(runtime) } : { ok: false, code: 'not-found' }
  } catch (error) {
    // `instanceof` is reliable here and only here: this runs in the process
    // that threw, with the real class. It is the client that cannot use it,
    // which is why the code goes onto the wire as data.
    if (error instanceof SpaceSlugTakenError) {
      return { ok: false, code: 'slug-taken' }
    }
    throw error
  }
}

export async function deleteSpaceImpl(slug: string): Promise<boolean> {
  const r = await registry()
  if (slug === DEFAULT_SPACE_SLUG && r.list().length <= 1) {
    return false
  }
  return r.remove(slug)
}

export async function setSpacePinnedImpl(data: { slug: string; pinned: boolean }): Promise<SpaceSummary | null> {
  const r = await registry()
  const runtime = await r.setPinned(data.slug, data.pinned)
  if (!runtime) {
    return null
  }
  return toSummary(runtime)
}

export async function exportSpaceImpl(slug: string): Promise<SpaceExport | null> {
  const r = await registry()
  const space = r.getBySlug(slug)
  if (!space) {
    return null
  }
  return {
    name: space.name,
    slug: space.slug,
    graph: space.graph,
    exportedAt: new Date().toISOString(),
  }
}

export async function importSpaceImpl(payload: SpaceExport): Promise<SpaceSummary> {
  const r = await registry()
  const existing = new Set(r.list().map((s) => s.slug))
  const desired = slugify(payload.slug || payload.name || 'space')
  const slug = uniqueSlug(desired, existing)
  const graph: GraphData = {
    nodes: Array.isArray(payload.graph?.nodes) ? payload.graph.nodes : [],
    edges: Array.isArray(payload.graph?.edges) ? payload.graph.edges : [],
  }
  const runtime = await r.create(payload.name || 'Imported', slug, graph)
  return toSummary(runtime)
}

export async function getActiveSpaceSlugImpl(): Promise<string> {
  const r = await registry()
  const active = await r.getActiveSlug()
  if (active) {
    return active
  }
  const list = r.list()
  return list[0]?.slug ?? DEFAULT_SPACE_SLUG
}

export async function setActiveSpaceSlugImpl(slug: string): Promise<void> {
  const r = await registry()
  // Resolved rather than merely existence-checked, and stored canonically: a
  // caller may hand over a slug a rename freed (an old URL, a stale tab), and
  // the setting is compared by equality when it is read back.
  const space = r.getBySlug(slug)
  if (!space) {
    return
  }
  await r.setActiveSlug(space.slug)
}

export async function findSpaceByNodeImpl(nodeId: string): Promise<SpaceSummary | null> {
  const r = await registry()
  const space = r.findByNode(nodeId)
  if (!space) {
    return null
  }
  return toSummary(space)
}
