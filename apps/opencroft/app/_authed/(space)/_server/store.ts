import { db, space, spaceSlugAlias } from '@opencroft/db'
import { and, asc, eq, inArray } from 'drizzle-orm'

import { slugify, uniqueSlug } from '@/app/_authed/(space)/_server/slug'
import {
  ACTIVE_SPACE_SETTING_ID,
  DEFAULT_SPACE_NAME,
  DEFAULT_SPACE_SLUG,
  type GraphData,
  LEGACY_GRAPH_SETTING_ID,
  type SpaceSummary,
} from '@/app/_authed/(space)/_server/types'
import { getSetting, upsertSetting } from '@/server/data'

interface SpaceRuntime {
  id: string
  slug: string
  name: string
  graph: GraphData
  pinned: boolean
  createdAt: Date
  updatedAt: Date
}

const EMPTY_GRAPH: GraphData = { nodes: [], edges: [] }

// Thrown by `saveGraph` when `expectedUpdatedAt` no longer matches the
// stored row — another writer (a different browser tab, or an MCP tool
// call) persisted a newer graph in between this caller's load and save.
export class GraphConflictError extends Error {
  constructor(readonly slug: string) {
    super(`Space "${slug}" was modified concurrently`)
    this.name = 'GraphConflictError'
  }
}

function parseGraph(data: string): GraphData {
  const parsed = JSON.parse(data) as Partial<GraphData>
  return {
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
  }
}

class SpacesRegistry {
  private spaces = new Map<string, SpaceRuntime>()
  private bySlug = new Map<string, string>()
  // Slugs a rename freed -> the space that answers to them now. Kept beside
  // `bySlug` rather than merged into it because the two are not equals: a live
  // slug always wins, and `list()` and every availability check must see only
  // the live ones.
  private aliasBySlug = new Map<string, string>()
  private loaded = false
  private loadPromise: Promise<void> | null = null

  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }
    if (!this.loadPromise) {
      this.loadPromise = this.load()
    }
    await this.loadPromise
  }

  private async load(): Promise<void> {
    await this.migrateLegacyGraph()
    const rows = await db.query.space.findMany({ orderBy: asc(space.createdAt) })
    for (const row of rows) {
      const runtime: SpaceRuntime = {
        id: row.id,
        slug: row.slug,
        name: row.name,
        graph: parseGraph(row.data),
        pinned: row.pinned,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
      this.spaces.set(row.id, runtime)
      this.bySlug.set(row.slug, row.id)
    }
    for (const alias of await db.query.spaceSlugAlias.findMany()) {
      this.aliasBySlug.set(alias.slug, alias.spaceId)
    }
    if (this.spaces.size === 0) {
      await this.createInternal(DEFAULT_SPACE_NAME, DEFAULT_SPACE_SLUG, EMPTY_GRAPH)
    }
    this.loaded = true
  }

  private async migrateLegacyGraph(): Promise<void> {
    const existing = await db.query.space.findFirst()
    if (existing) {
      return
    }
    const legacy = await getSetting(LEGACY_GRAPH_SETTING_ID)
    if (!legacy) {
      return
    }
    const graph = parseGraph(legacy.data)
    await db.insert(space).values({
      slug: DEFAULT_SPACE_SLUG,
      name: DEFAULT_SPACE_NAME,
      data: JSON.stringify(graph),
    })
  }

  private async createInternal(name: string, slug: string, graph: GraphData): Promise<SpaceRuntime> {
    // A live space outranks an alias, so taking this slug takes it outright.
    await this.dropAliases([slug])
    const [row] = await db
      .insert(space)
      .values({ name, slug, data: JSON.stringify(graph) })
      .returning()
    const runtime: SpaceRuntime = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      graph,
      pinned: row.pinned,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
    this.spaces.set(runtime.id, runtime)
    this.bySlug.set(runtime.slug, runtime.id)
    return runtime
  }

  list(): SpaceSummary[] {
    return [...this.spaces.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        pinned: s.pinned,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      }))
  }

  /**
   * A space by slug, live first and then by a slug a rename freed.
   *
   * Every caller gets the alias fallback, which is the point: a bookmarked
   * canvas URL, the stored active-space slug and an extension configured with a
   * space name are all addresses written down outside this process, and nothing
   * rewrites them when someone renames a space.
   *
   * Live first is load-bearing -- if another space has since taken the freed
   * slug, the space holding it now is the answer. Creating and renaming both
   * delete the alias on a slug they bind, so the two should never both match.
   */
  getBySlug(slug: string): SpaceRuntime | null {
    const id = this.bySlug.get(slug) ?? this.aliasBySlug.get(slug)
    if (!id) {
      return null
    }
    return this.spaces.get(id) ?? null
  }

  private async dropAliases(slugs: string[]): Promise<void> {
    const present = slugs.filter((s) => this.aliasBySlug.has(s))
    if (present.length === 0) {
      return
    }
    await db.delete(spaceSlugAlias).where(inArray(spaceSlugAlias.slug, present))
    for (const s of present) {
      this.aliasBySlug.delete(s)
    }
  }

  getById(id: string): SpaceRuntime | null {
    return this.spaces.get(id) ?? null
  }

  findByNode(nodeId: string): SpaceRuntime | null {
    for (const s of this.spaces.values()) {
      if (s.graph.nodes.some((n) => (n as { id?: string }).id === nodeId)) {
        return s
      }
    }
    return null
  }

  async create(name: string, slug: string, graph: GraphData): Promise<SpaceRuntime> {
    return this.createInternal(name, slug, graph)
  }

  async setPinned(slug: string, pinned: boolean): Promise<SpaceRuntime | null> {
    const id = this.bySlug.get(slug)
    if (!id) {
      return null
    }
    const runtime = this.spaces.get(id)!
    const [row] = await db.update(space).set({ pinned }).where(eq(space.id, id)).returning()
    runtime.pinned = row.pinned
    runtime.updatedAt = row.updatedAt
    return runtime
  }

  /**
   * Rename a space: the name people read AND the slug everything addresses it
   * by. Resolves through an alias like every other lookup, so renaming twice in
   * a row works from either address.
   *
   * THE SLUG MOVES BECAUSE IT IS AN ADDRESS. It is in canvas URLs, in the
   * stored active-space setting, and in whatever an extension was configured
   * with -- a space still answering to a name it no longer has is the same
   * defect a renamed group chat had.
   *
   * A CLASH IS SUFFIXED, NOT REFUSED, because that is what creating a space
   * already does (`createSpaceImpl`/`importSpaceImpl` both go through
   * `uniqueSlug`) and this returns the resulting summary, so the caller is told
   * the slug it actually got rather than being left to assume. A name with
   * nothing to build an address from lands on `slugify`'s own fallback for the
   * same reason. Group chats refuse instead -- their creation refuses too, and
   * the rule in both places is "a rename behaves the way a creation would".
   *
   * The old slug keeps resolving, and the active-space setting is moved with
   * it: that setting is read back through a plain equality check, so a rename
   * that left it pointing at the old slug would silently drop the reader onto a
   * different space on their next load.
   */
  async rename(slug: string, name: string): Promise<SpaceRuntime | null> {
    const id = this.bySlug.get(slug) ?? this.aliasBySlug.get(slug)
    if (!id) {
      return null
    }
    const runtime = this.spaces.get(id)
    if (!runtime) {
      return null
    }
    const previousSlug = runtime.slug
    // Every OTHER space's slug: renaming to a name that slugifies to what this
    // space already answers to must not suffix itself into a new address.
    const taken = new Set([...this.bySlug.keys()].filter((s) => s !== previousSlug))
    const nextSlug = uniqueSlug(slugify(name), taken)
    const [row] = await db.update(space).set({ name, slug: nextSlug }).where(eq(space.id, id)).returning()
    runtime.name = row.name
    runtime.slug = row.slug
    runtime.updatedAt = row.updatedAt
    if (row.slug === previousSlug) {
      return runtime
    }
    this.bySlug.delete(previousSlug)
    this.bySlug.set(row.slug, id)
    await this.dropAliases([row.slug, previousSlug])
    await db.insert(spaceSlugAlias).values({ slug: previousSlug, spaceId: id })
    this.aliasBySlug.set(previousSlug, id)
    if ((await this.readActiveSlug()) === previousSlug) {
      await this.setActiveSlug(row.slug)
    }
    return runtime
  }

  async remove(slug: string): Promise<boolean> {
    const id = this.bySlug.get(slug) ?? this.aliasBySlug.get(slug)
    if (!id) {
      return false
    }
    const runtime = this.spaces.get(id)
    await db.delete(space).where(eq(space.id, id))
    this.spaces.delete(id)
    this.bySlug.delete(runtime?.slug ?? slug)
    // The rows cascade with the space; this drops the in-memory mirror of them.
    for (const [aliasSlug, aliasId] of this.aliasBySlug) {
      if (aliasId === id) {
        this.aliasBySlug.delete(aliasSlug)
      }
    }
    return true
  }

  // `expectedUpdatedAt`, when given, must match the row's current `updatedAt`
  // or the write is rejected (GraphConflictError) instead of silently
  // clobbering a newer save from another tab/tool call. The condition is
  // enforced by the UPDATE's WHERE clause so the check-then-write is atomic
  // even across concurrent requests.
  async saveGraph(slug: string, graph: GraphData, expectedUpdatedAt?: string): Promise<SpaceRuntime | null> {
    const id = this.bySlug.get(slug)
    if (!id) {
      return null
    }
    const runtime = this.spaces.get(id)!
    // `updatedAt` is millisecond-precision, not a monotonic counter, so two
    // writers racing within the same millisecond — plus a third stale writer
    // whose expectedUpdatedAt happens to match — could theoretically both pass
    // this check. Accepted risk for v1: real writers are paced well above 1ms
    // (canvas autosave debounces 500ms, MCP tool calls run sequentially per
    // session). If conflict reports ever show writes slipping through, replace
    // this with a monotonic integer `version` column instead of tightening the
    // timestamp comparison.
    const condition = expectedUpdatedAt
      ? and(eq(space.id, id), eq(space.updatedAt, new Date(expectedUpdatedAt)))
      : eq(space.id, id)
    const [row] = await db
      .update(space)
      .set({ data: JSON.stringify(graph) })
      .where(condition)
      .returning()
    if (!row) {
      throw new GraphConflictError(slug)
    }
    runtime.graph = graph
    runtime.updatedAt = row.updatedAt
    return runtime
  }

  async setActiveSlug(slug: string): Promise<void> {
    await upsertSetting(ACTIVE_SPACE_SETTING_ID, JSON.stringify({ slug }))
  }

  /** The stored value, whether or not it still names a live space. */
  private async readActiveSlug(): Promise<string | null> {
    const row = await getSetting(ACTIVE_SPACE_SETTING_ID)
    if (!row) {
      return null
    }
    const { slug } = JSON.parse(row.data) as { slug?: string }
    return slug ?? null
  }

  // Answers with the space's CURRENT slug, resolving a stored value through an
  // alias first: the setting is written once and read on every load, so a value
  // left over from before a rename must land on the space it named rather than
  // silently falling back to whichever space happens to be first.
  async getActiveSlug(): Promise<string | null> {
    const slug = await this.readActiveSlug()
    return slug ? (this.getBySlug(slug)?.slug ?? null) : null
  }
}

const globalForSpaces = globalThis as unknown as { __SPACES_REGISTRY__?: SpacesRegistry }

export function getSpacesRegistry(): SpacesRegistry {
  if (!globalForSpaces.__SPACES_REGISTRY__) {
    globalForSpaces.__SPACES_REGISTRY__ = new SpacesRegistry()
  }
  return globalForSpaces.__SPACES_REGISTRY__
}

export type { SpaceRuntime }
