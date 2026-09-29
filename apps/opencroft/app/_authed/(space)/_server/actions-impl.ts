// The actual space-registry logic, deliberately separate from actions.ts.
//
// TWO REASONS THIS FILE EXISTS. Both have already caused a real bug, so
// neither is theoretical:
//
// 1. CLIENT BUNDLE. actions.ts is reachable from client code (canvas UI and
//    the spaces page import its server functions). The client transform only
//    replaces `createServerFn(...).handler(...)` expressions with RPC stubs —
//    a plain exported function in that same file gets no stub and ships its
//    server-only imports straight to the browser. That is the acp.ts leak
//    (see acp.ts/acp-impl.ts, token-actions.ts/token-actions-impl.ts).
//
// 2. IN-PROCESS CALLERS WITH NO SESSION. (mcp)/_server/tools.ts and
//    graph-conflict-retry.ts call these operations directly, in-process, to
//    serve MCP tool calls. /mcp is a bearer-token surface and carries no
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

import { isSpaceIconPreset } from '@opencroft/db/space-icon-presets'

import { resolveGraphContexts } from '@/app/_authed/(extension-runtime)/_server/graph-context-resolver'
import type { GraphSnapshot } from '@/app/_authed/(extension-runtime)/_server/host'
import { slugify, uniqueSlug } from '@/app/_authed/(space)/_server/slug'
import { getSpacesRegistry, type SpaceRuntime, SpaceSlugTakenError } from '@/app/_authed/(space)/_server/store'
import type { GraphData, SpaceSummary } from '@/app/_authed/(space)/_server/types'
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
    icon: runtime.icon,
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

/** `slug` is a graph address: `<space>` (its default graph) or `<space>.<graph>`. */
export async function loadSpaceGraphImpl(slug: string): Promise<{ graph: GraphData; updatedAt: string } | null> {
  const r = await registry()
  const ref = r.resolveGraph(slug)
  if (!ref) {
    return null
  }
  return { graph: ref.graph.graph, updatedAt: ref.graph.updatedAt.toISOString() }
}

export async function saveSpaceGraphImpl(data: {
  /** Graph address, same grammar loadSpaceGraphImpl takes. */
  slug: string
  graph: GraphData
  expectedUpdatedAt?: string
}): Promise<{ updatedAt: string }> {
  const r = await registry()
  const resolved = await resolveGraph(data.graph)
  const ref = await r.saveGraph(data.slug, resolved, data.expectedUpdatedAt)
  if (!ref) {
    throw new Error(`Graph not found: ${data.slug}`)
  }
  // Single broadcast point for every graph mutation (canvas autosave and
  // MCP node/edge tools alike) so any other open tab resyncs instead of
  // later overwriting this write with a stale snapshot. Scoped to the SPACE:
  // the version signal stays one per space, so a canvas showing another
  // graph of it refetches its own address -- a spare fetch, never a miss.
  toastStore.broadcast({ type: 'graph_updated', spaceId: ref.space.slug })
  return { updatedAt: ref.graph.updatedAt.toISOString() }
}

/**
 * Which of `ids` another graph -- any graph but `exceptAddress` -- already
 * uses as a node or edge id. A paste keeps its ids unless they are taken; the
 * graph being pasted into is left out because the canvas holds it newer than
 * the server does (a cut there may not be saved yet), so it checks that one
 * itself.
 */
export async function findTakenGraphIdsImpl(data: { ids: string[]; exceptAddress?: string }): Promise<string[]> {
  const r = await registry()
  const except = data.exceptAddress ? r.resolveGraph(data.exceptAddress)?.graph.id : undefined
  const wanted = new Set(data.ids)
  const taken = new Set<string>()
  for (const ref of r.listGraphs()) {
    if (ref.graph.id === except) {
      continue
    }
    for (const item of [...ref.graph.graph.nodes, ...ref.graph.graph.edges]) {
      const id = (item as { id?: unknown }).id
      if (typeof id === 'string' && wanted.has(id)) {
        taken.add(id)
      }
    }
  }
  return [...taken]
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

/**
 * A slug an agent handed us, resolved to the slug that space answers to NOW,
 * or null.
 *
 * Exists so no caller has to match slugs itself. The MCP surface used to do
 * that -- `listSpacesImpl()` then a `===` against each `slug` -- which reads
 * like a lookup and is not one: it sees live spaces only, so a renamed space
 * disappeared from every agent tool while the web routes, which go through the
 * registry, resolved it fine. Agents keep space slugs in their own skills and
 * notes, so that is the whole surface an agent addresses a space through.
 *
 * Returns the CANONICAL slug rather than the input, so a caller that stores or
 * echoes the result carries the current address forward instead of keeping the
 * freed one alive.
 */
export async function resolveSpaceSlugImpl(slug: string): Promise<string | null> {
  const r = await registry()
  return r.getBySlug(slug)?.slug ?? null
}

/** Deleted, or false when no space answers to the slug. */
export async function deleteSpaceImpl(slug: string): Promise<boolean> {
  const r = await registry()
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

// An uploaded icon has the same contract as an account avatar (packages/auth
// updateOwnAvatar): a small, self-contained image data URL. The client
// re-encodes to a small square before sending; this cap is the server's own
// say, not a copy of the client's.
const MAX_ICON_CHARS = 64 * 1024
const ICON_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

/** Throws unless the value is a known preset or an image a space may store. */
export function assertSpaceIcon(icon: unknown): asserts icon is string {
  if (typeof icon !== 'string') {
    throw new Error('A space always has an icon.')
  }
  if (icon.startsWith('preset:')) {
    if (!isSpaceIconPreset(icon)) {
      throw new Error('That is not one of the preset icons.')
    }
    return
  }
  if (!ICON_DATA_URL.test(icon)) {
    throw new Error('A space icon must be a preset or a PNG, JPEG or WebP image.')
  }
  if (icon.length > MAX_ICON_CHARS) {
    throw new Error('That image is too large to store. Choose a smaller one.')
  }
}

export async function setSpaceIconImpl(data: { slug: string; icon: string }): Promise<SpaceSummary | null> {
  assertSpaceIcon(data.icon)
  const r = await registry()
  const runtime = await r.setIcon(data.slug, data.icon)
  if (!runtime) {
    return null
  }
  return toSummary(runtime)
}

/** What a Graph App instance's view needs to draw its canvas. */
export interface GraphInstanceView {
  /** The graph's address: what the canvas loads and saves by. */
  address: string
  graphName: string
  spaceSlug: string
  spaceName: string
}

export async function getGraphViewForInstanceImpl(instanceId: string): Promise<GraphInstanceView | null> {
  const r = await registry()
  const graph = r.graphByInstance(instanceId)
  if (!graph) {
    return null
  }
  const space = r.getById(graph.spaceId)
  if (!space) {
    return null
  }
  return {
    address: `${space.slug}.${graph.slug}`,
    graphName: graph.name,
    spaceSlug: space.slug,
    spaceName: space.name,
  }
}
