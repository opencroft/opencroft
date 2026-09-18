import { db, space, spaceApp, spaceGraph, spaceSlugAlias } from '@opencroft/db'
import { and, asc, eq, inArray } from 'drizzle-orm'

import { slugify } from '@/app/_authed/(space)/_server/slug'
import {
  ACTIVE_SPACE_SETTING_ID,
  DEFAULT_GRAPH_NAME,
  DEFAULT_GRAPH_SLUG,
  DEFAULT_SPACE_NAME,
  DEFAULT_SPACE_SLUG,
  GRAPH_APP_EXTENSION_ID,
  GRAPH_APP_SLUG,
  type GraphData,
  LEGACY_GRAPH_SETTING_ID,
  parseGraphAddress,
  type SpaceSummary,
} from '@/app/_authed/(space)/_server/types'
import { getSetting, upsertSetting } from '@/server/data'

/**
 * One graph of a space: what one canvas draws. Owned by exactly one Graph App
 * instance -- the instance is the door to it in the UI, and removing the
 * instance removes the graph (see removeGraphByInstance).
 */
interface GraphRuntime {
  id: string
  spaceId: string
  /** The graph's own slug; the full address is `<space-slug>.<slug>`. */
  slug: string
  name: string
  /** The Graph App instance this graph belongs to. */
  instanceId: string
  graph: GraphData
  createdAt: Date
  updatedAt: Date
}

interface SpaceRuntime {
  id: string
  slug: string
  name: string
  /** This space's graphs, keyed by their graph slug. */
  graphs: Map<string, GraphRuntime>
  /** Which graph a bare `<space>` address resolves to. */
  defaultGraphSlug: string
  pinned: boolean
  icon: string | null
  createdAt: Date
  updatedAt: Date
}

/** A resolved graph address: the space and the graph within it. */
interface GraphRef {
  space: SpaceRuntime
  graph: GraphRuntime
}

const EMPTY_GRAPH: GraphData = { nodes: [], edges: [] }

// Thrown by `rename` when the name given slugifies onto an address another
// space already holds.
//
// A REFUSAL, NOT A SUFFIX, and the distinction is the point of this whole
// change: creation asks for *a* space and takes the address it is given, so
// `createSpaceImpl` appends `-2` quite correctly. A rename asks for *that*
// address. Quietly handing back `thing-2` leaves a working system pointing
// somewhere nobody named, with nothing to read that says so -- the same failure
// every other rule here exists to remove.
export class SpaceSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`Another space already answers to "${slug}"`)
    this.name = 'SpaceSlugTakenError'
  }
}

// Thrown by `saveGraph` when `expectedUpdatedAt` no longer matches the
// stored row — another writer (a different browser tab, or an MCP tool
// call) persisted a newer graph in between this caller's load and save.
export class GraphConflictError extends Error {
  constructor(readonly address: string) {
    super(`Graph "${address}" was modified concurrently`)
    this.name = 'GraphConflictError'
  }
}

// Thrown by `createGraph` when the name slugifies onto a graph the space
// already has. A refusal for the same reason a space rename refuses: handing
// back a suffixed slug would leave an instance pointing at an address nobody
// named.
export class GraphSlugTakenError extends Error {
  constructor(readonly address: string) {
    super(`A graph already answers to "${address}"`)
    this.name = 'GraphSlugTakenError'
  }
}

// Thrown by `removeGraphByInstance` for the graph a bare `<space>` address
// resolves to. Removing it would leave the space's own canvas with nothing to
// draw; the default has to be pointed at another graph first.
export class DefaultGraphRemovalError extends Error {
  constructor(readonly address: string) {
    super(`"${address}" is the space's default graph; make another graph the default before removing it`)
    this.name = 'DefaultGraphRemovalError'
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
  private graphsByInstance = new Map<string, GraphRuntime>()
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
        graphs: new Map(),
        defaultGraphSlug: row.defaultGraphSlug,
        pinned: row.pinned,
        icon: row.icon,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
      this.spaces.set(row.id, runtime)
      this.bySlug.set(row.slug, row.id)
    }
    for (const row of await db.query.spaceGraph.findMany({ orderBy: asc(spaceGraph.createdAt) })) {
      const owner = this.spaces.get(row.spaceId)
      if (!owner) {
        continue
      }
      this.registerGraph(owner, {
        id: row.id,
        spaceId: row.spaceId,
        slug: row.slug,
        name: row.name,
        instanceId: row.instanceId,
        graph: parseGraph(row.data),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
    }
    await this.migrateGraphlessSpaces(rows)
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

  /**
   * THE ONE-TIME GRAPH MIGRATION. A space from before graphs were rows holds
   * its whole graph in `space.data` and has no SpaceGraph rows; each such
   * space gets its legacy graph as a "default" graph, owned by a Graph App
   * instance created alongside it -- so the migrated graph is exactly what a
   * hand-added graph is, with nothing special about it but its slug.
   *
   * Idempotent by its guard: a space with ANY graph rows is left alone, and
   * `space.data` itself is never written -- it stays inert, per the same
   * no-cleanup rule every retired storage shape here follows.
   *
   * The instance row is inserted directly rather than through the app-add
   * flow: onAdded's job is creating the graph row, which this migration is
   * itself doing. The instance's data directory appears when the apps
   * runtime first loads it, as with any instance restored from the table.
   */
  private async migrateGraphlessSpaces(rows: (typeof space.$inferSelect)[]): Promise<void> {
    for (const row of rows) {
      const runtime = this.spaces.get(row.id)
      if (!runtime || runtime.graphs.size > 0) {
        continue
      }
      const created = await db.transaction(async (tx) => {
        const [instance] = await tx
          .insert(spaceApp)
          .values({
            spaceId: row.id,
            extensionId: GRAPH_APP_EXTENSION_ID,
            appSlug: GRAPH_APP_SLUG,
            name: DEFAULT_GRAPH_NAME,
            slug: DEFAULT_GRAPH_SLUG,
          })
          .returning()
        const [graphRow] = await tx
          .insert(spaceGraph)
          .values({
            spaceId: row.id,
            instanceId: instance.id,
            slug: DEFAULT_GRAPH_SLUG,
            name: DEFAULT_GRAPH_NAME,
            data: row.data,
          })
          .returning()
        return graphRow
      })
      this.registerGraph(runtime, {
        id: created.id,
        spaceId: created.spaceId,
        slug: created.slug,
        name: created.name,
        instanceId: created.instanceId,
        graph: parseGraph(created.data),
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      })
    }
  }

  private registerGraph(owner: SpaceRuntime, graph: GraphRuntime): void {
    owner.graphs.set(graph.slug, graph)
    this.graphsByInstance.set(graph.instanceId, graph)
  }

  private async createInternal(name: string, slug: string, graph: GraphData): Promise<SpaceRuntime> {
    // A live space outranks an alias, so taking this slug takes it outright.
    await this.dropAliases([slug])
    // The space, its default graph and the Graph App instance owning it are
    // one creation: a space without a default graph has a canvas address that
    // resolves to nothing.
    const { row, graphRow } = await db.transaction(async (tx) => {
      const [spaceRow] = await tx
        .insert(space)
        .values({ name, slug, data: JSON.stringify(EMPTY_GRAPH) })
        .returning()
      const [instanceRow] = await tx
        .insert(spaceApp)
        .values({
          spaceId: spaceRow.id,
          extensionId: GRAPH_APP_EXTENSION_ID,
          appSlug: GRAPH_APP_SLUG,
          name: DEFAULT_GRAPH_NAME,
          slug: DEFAULT_GRAPH_SLUG,
        })
        .returning()
      const [createdGraph] = await tx
        .insert(spaceGraph)
        .values({
          spaceId: spaceRow.id,
          instanceId: instanceRow.id,
          slug: DEFAULT_GRAPH_SLUG,
          name: DEFAULT_GRAPH_NAME,
          data: JSON.stringify(graph),
        })
        .returning()
      return { row: spaceRow, graphRow: createdGraph }
    })
    const runtime: SpaceRuntime = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      graphs: new Map(),
      defaultGraphSlug: row.defaultGraphSlug,
      pinned: row.pinned,
      icon: row.icon,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
    this.registerGraph(runtime, {
      id: graphRow.id,
      spaceId: graphRow.spaceId,
      slug: graphRow.slug,
      name: graphRow.name,
      instanceId: graphRow.instanceId,
      graph,
      createdAt: graphRow.createdAt,
      updatedAt: graphRow.updatedAt,
    })
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
        icon: s.icon,
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
    const id = this.idFor(slug)
    return id ? (this.spaces.get(id) ?? null) : null
  }

  /**
   * THE ONE PLACE a graph address becomes a graph: `<space>` is the space's
   * default graph, `<space>.<graph>` a named one. The space part resolves
   * through the same alias fallback every space lookup gets.
   */
  resolveGraph(address: string): GraphRef | null {
    const { spaceSlug, graphSlug } = parseGraphAddress(address)
    const owner = this.getBySlug(spaceSlug)
    if (!owner) {
      return null
    }
    const graph = owner.graphs.get(graphSlug ?? owner.defaultGraphSlug)
    return graph ? { space: owner, graph } : null
  }

  /** Every graph of every space, for the whole-graph consumers (search, MCP listings). */
  listGraphs(): GraphRef[] {
    const refs: GraphRef[] = []
    for (const s of this.spaces.values()) {
      for (const graph of s.graphs.values()) {
        refs.push({ space: s, graph })
      }
    }
    return refs
  }

  graphsOf(spaceSlug: string): GraphRuntime[] {
    const owner = this.getBySlug(spaceSlug)
    return owner ? [...owner.graphs.values()] : []
  }

  graphByInstance(instanceId: string): GraphRuntime | null {
    return this.graphsByInstance.get(instanceId) ?? null
  }

  /** The full address of a graph: `<space-slug>.<graph-slug>`. */
  addressOf(ref: GraphRef): string {
    return `${ref.space.slug}.${ref.graph.slug}`
  }

  /**
   * THE ONE PLACE a slug becomes a space. Live first, then a slug a rename
   * freed.
   *
   * Written once and used by every method that takes a slug, because the
   * alternative was proved to fail: three of them resolved live-only after the
   * alias landed, and the misses were invisible -- a canvas autosaving under
   * the address its page was loaded with got "Space not found" the moment
   * somebody renamed the space out from under it.
   *
   * The ONE deliberate exception is the availability check in `rename`, which
   * asks `bySlug` directly. An alias must never read as taken, or a freed
   * address could not be handed to another space.
   */
  private idFor(slug: string): string | undefined {
    return this.bySlug.get(slug) ?? this.aliasBySlug.get(slug)
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

  findByNode(nodeId: string): GraphRef | null {
    for (const s of this.spaces.values()) {
      for (const graph of s.graphs.values()) {
        if (graph.graph.nodes.some((n) => (n as { id?: string }).id === nodeId)) {
          return { space: s, graph }
        }
      }
    }
    return null
  }

  async create(name: string, slug: string, graph: GraphData): Promise<SpaceRuntime> {
    return this.createInternal(name, slug, graph)
  }

  /**
   * A graph for a Graph App instance -- the onAdded hook's job. The slug is
   * the INSTANCE's (minted by the platform from the name, unique among the
   * space's instances), so a graph's address and its instance's address are
   * one address. A taken slug is still refused defensively: it would mean
   * a graph exists whose instance is gone, and owning it would double-own
   * its data.
   */
  async createGraph(spaceSlug: string, name: string, slug: string, instanceId: string): Promise<GraphRuntime> {
    const owner = this.getBySlug(spaceSlug)
    if (!owner) {
      throw new Error(`Space not found: ${spaceSlug}`)
    }
    if (owner.graphs.has(slug)) {
      throw new GraphSlugTakenError(`${owner.slug}.${slug}`)
    }
    const [row] = await db
      .insert(spaceGraph)
      .values({
        spaceId: owner.id,
        instanceId,
        slug,
        name,
        data: JSON.stringify(EMPTY_GRAPH),
      })
      .returning()
    const runtime: GraphRuntime = {
      id: row.id,
      spaceId: row.spaceId,
      slug: row.slug,
      name: row.name,
      instanceId: row.instanceId,
      graph: EMPTY_GRAPH,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
    this.registerGraph(owner, runtime)
    return runtime
  }

  /**
   * Remove the graph an instance owns -- the onRemoved hook's job, so the
   * data dies with the instance. The DEFAULT graph is refused: a bare
   * `<space>` address must always resolve, so the default has to be pointed
   * elsewhere before its graph can go.
   */
  async removeGraphByInstance(instanceId: string): Promise<void> {
    const graph = this.graphsByInstance.get(instanceId)
    if (!graph) {
      return
    }
    const owner = this.spaces.get(graph.spaceId)
    if (owner && owner.defaultGraphSlug === graph.slug) {
      throw new DefaultGraphRemovalError(`${owner.slug}.${graph.slug}`)
    }
    await db.delete(spaceGraph).where(eq(spaceGraph.id, graph.id))
    owner?.graphs.delete(graph.slug)
    this.graphsByInstance.delete(instanceId)
  }

  /**
   * A graph's name AND its address -- the onRenamed hook's job when an
   * instance's name changes.
   *
   * THE SLUG MOVES WITH THE NAME. It did not used to: the slug was an address
   * fixed at creation, so everything written down outside this process kept
   * resolving. That was reversed deliberately, knowing the
   * consequence -- previously saved links stop resolving -- so this is not an
   * oversight to soften later with an alias or a redirect.
   *
   * It moves HERE, driven by the instance's own rename, because one instance
   * is one graph is one address. The platform has already re-slugged the
   * instance by the time this runs; a graph left on its old slug would make
   * `<space>.<app-slug>` and `<space>.<graph-slug>` two different addresses
   * for the same thing, which is the invariant the whole Graph App rests on.
   *
   * Refused when the new slug is taken, for the reason the add path refuses:
   * answering to an address nobody named is worse than refusing to move.
   *
   * THE DEFAULT-GRAPH POINTER FOLLOWS, and that is not a detail. It is stored
   * as a slug, so renaming a space's default graph without moving it would
   * leave the bare `<space>` address resolving to nothing -- the space's own
   * canvas, gone, from a rename. Both writes go in one transaction so a
   * failure cannot leave the pointer aimed at a slug that no longer exists.
   */
  async renameGraphByInstance(instanceId: string, name: string, slug: string): Promise<GraphRuntime | null> {
    const graph = this.graphsByInstance.get(instanceId)
    if (!graph) {
      return null
    }
    const owner = this.spaces.get(graph.spaceId)
    if (slug !== graph.slug && owner?.graphs.has(slug)) {
      throw new GraphSlugTakenError(`${owner.slug}.${slug}`)
    }
    const previousSlug = graph.slug
    const movesDefault = owner?.defaultGraphSlug === previousSlug
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(spaceGraph).set({ name, slug }).where(eq(spaceGraph.id, graph.id)).returning()
      if (movesDefault && owner) {
        await tx.update(space).set({ defaultGraphSlug: slug }).where(eq(space.id, owner.id))
      }
      return updated
    })
    graph.name = row.name
    graph.slug = row.slug
    graph.updatedAt = row.updatedAt
    if (owner) {
      owner.graphs.delete(previousSlug)
      owner.graphs.set(graph.slug, graph)
      if (movesDefault) {
        owner.defaultGraphSlug = graph.slug
      }
    }
    return graph
  }

  /**
   * Follow an App-instance transfer: the platform has already moved the
   * spaceApp row -- and already resolved the instance's slug and name for
   * the target space (keep when free, else donor space's name, else a
   * numbered suffix) -- and this moves the graph the instance owns with it,
   * mirroring that resolved slug and name onto the graph row so the two
   * stay one address. The graph keeps its identity (row id, instance, node
   * ids) throughout -- the Graph App's onTransferred hook.
   *
   * Transferring a space's DEFAULT graph is allowed only when it is that
   * space's ONLY graph -- the donor gets a fresh empty default in its place,
   * so a bare `<space>` address never stops resolving. With other graphs
   * present the default has to be re-pointed first, same as removal.
   */
  async transferGraphByInstance(instanceId: string, _previousSpaceSlug: string): Promise<GraphRef> {
    const graph = this.graphsByInstance.get(instanceId)
    if (!graph) {
      throw new Error(`No graph behind instance: ${instanceId}`)
    }
    const source = this.spaces.get(graph.spaceId)
    if (!source) {
      throw new Error(`Space not found for graph: ${graph.slug}`)
    }
    const row = await db.query.spaceApp.findFirst({ where: eq(spaceApp.id, instanceId) })
    const target = row ? this.spaces.get(row.spaceId) : null
    if (!row || !target) {
      throw new Error(`Target space not found for instance: ${instanceId}`)
    }
    if (target.id === source.id) {
      return { space: target, graph }
    }
    const slug = row.slug
    const name = row.name
    if (target.graphs.has(slug)) {
      // Cannot happen while every graph slug mirrors its instance slug (the
      // platform just verified the instance slug free) -- refusing beats
      // silently double-addressing two graphs.
      throw new GraphSlugTakenError(`${target.slug}.${slug}`)
    }
    const isDefault = source.defaultGraphSlug === graph.slug
    if (isDefault && source.graphs.size > 1) {
      throw new DefaultGraphRemovalError(`${source.slug}.${graph.slug}`)
    }
    const replacement = await db.transaction(async (tx) => {
      const [moved] = await tx
        .update(spaceGraph)
        .set({ spaceId: target.id, slug, name })
        .where(eq(spaceGraph.id, graph.id))
        .returning()
      graph.updatedAt = moved.updatedAt
      if (!isDefault) {
        return null
      }
      const [instance] = await tx
        .insert(spaceApp)
        .values({
          spaceId: source.id,
          extensionId: GRAPH_APP_EXTENSION_ID,
          appSlug: GRAPH_APP_SLUG,
          name: DEFAULT_GRAPH_NAME,
          slug: DEFAULT_GRAPH_SLUG,
        })
        .returning()
      const [fresh] = await tx
        .insert(spaceGraph)
        .values({
          spaceId: source.id,
          instanceId: instance.id,
          slug: DEFAULT_GRAPH_SLUG,
          name: DEFAULT_GRAPH_NAME,
        })
        .returning()
      return fresh
    })
    source.graphs.delete(graph.slug)
    graph.spaceId = target.id
    graph.slug = slug
    graph.name = name
    target.graphs.set(slug, graph)
    if (replacement) {
      this.registerGraph(source, {
        id: replacement.id,
        spaceId: replacement.spaceId,
        slug: replacement.slug,
        name: replacement.name,
        instanceId: replacement.instanceId,
        graph: parseGraph(replacement.data),
        createdAt: replacement.createdAt,
        updatedAt: replacement.updatedAt,
      })
    }
    return { space: target, graph }
  }

  /** Point the bare `<space>` address at another of the space's graphs. */
  async setDefaultGraph(spaceSlug: string, graphSlug: string): Promise<SpaceRuntime | null> {
    const owner = this.getBySlug(spaceSlug)
    if (!owner) {
      return null
    }
    if (!owner.graphs.has(graphSlug)) {
      throw new Error(`Graph not found: ${owner.slug}.${graphSlug}`)
    }
    const [row] = await db.update(space).set({ defaultGraphSlug: graphSlug }).where(eq(space.id, owner.id)).returning()
    owner.defaultGraphSlug = row.defaultGraphSlug
    owner.updatedAt = row.updatedAt
    return owner
  }

  async setPinned(slug: string, pinned: boolean): Promise<SpaceRuntime | null> {
    const id = this.idFor(slug)
    if (!id) {
      return null
    }
    const runtime = this.spaces.get(id)!
    const [row] = await db.update(space).set({ pinned }).where(eq(space.id, id)).returning()
    runtime.pinned = row.pinned
    runtime.updatedAt = row.updatedAt
    return runtime
  }

  /** Set the space's icon (a small data URL), or clear it with `null`. */
  async setIcon(slug: string, icon: string | null): Promise<SpaceRuntime | null> {
    const id = this.idFor(slug)
    if (!id) {
      return null
    }
    const runtime = this.spaces.get(id)!
    const [row] = await db.update(space).set({ icon }).where(eq(space.id, id)).returning()
    runtime.icon = row.icon
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
   * A CLASH IS REFUSED and nothing changes -- not even the display name. See
   * `SpaceSlugTakenError` for why a rename is not a creation. A name with
   * nothing to build an address from still lands on `slugify`'s own fallback,
   * `space`, which is refused in turn if another space holds it.
   *
   * An ALIAS never counts as taken. Only live spaces do, which is what makes an
   * address handed over between two spaces possible at all: the first rename
   * frees it, the second claims it and drops the alias.
   *
   * The old slug keeps resolving, and the active-space setting is moved with
   * it: that setting is read back through a plain equality check, so a rename
   * that left it pointing at the old slug would silently drop the reader onto a
   * different space on their next load.
   *
   * Graph addresses ride on the space part and move with it -- the graphs
   * themselves are keyed by space id and their own slug, which a space rename
   * does not touch.
   */
  async rename(slug: string, name: string): Promise<SpaceRuntime | null> {
    const id = this.idFor(slug)
    if (!id) {
      return null
    }
    const runtime = this.spaces.get(id)
    if (!runtime) {
      return null
    }
    const previousSlug = runtime.slug
    // `nextSlug !== previousSlug` first: a space renamed to a name that
    // slugifies to the address it already answers to is a display change, and
    // testing the map alone would have it refuse against itself.
    const nextSlug = slugify(name)
    if (nextSlug !== previousSlug && this.bySlug.has(nextSlug)) {
      throw new SpaceSlugTakenError(nextSlug)
    }
    if (nextSlug === previousSlug) {
      // Display change only: no address moved, so there is nothing to free and
      // nothing to alias.
      const [row] = await db.update(space).set({ name }).where(eq(space.id, id)).returning()
      runtime.name = row.name
      runtime.updatedAt = row.updatedAt
      return runtime
    }
    // ONE TRANSACTION over the three writes, because each is only correct with
    // the others: the row's new address, the alias on it dropped so a live
    // binding is never outranked, and the freed address recorded. A failure
    // between them leaves either an address resolving nowhere or one with two
    // answers.
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(space).set({ name, slug: nextSlug }).where(eq(space.id, id)).returning()
      await tx.delete(spaceSlugAlias).where(inArray(spaceSlugAlias.slug, [nextSlug, previousSlug]))
      await tx.insert(spaceSlugAlias).values({ slug: previousSlug, spaceId: id })
      return updated
    })
    runtime.name = row.name
    runtime.slug = row.slug
    runtime.updatedAt = row.updatedAt
    // In-memory only after the commit -- these mirror the rows, so publishing
    // them before the write is durable would answer with a state a rollback
    // could take back.
    this.bySlug.delete(previousSlug)
    this.bySlug.set(row.slug, id)
    this.aliasBySlug.delete(nextSlug)
    this.aliasBySlug.set(previousSlug, id)
    if ((await this.readActiveSlug()) === previousSlug) {
      await this.setActiveSlug(row.slug)
    }
    return runtime
  }

  async remove(slug: string): Promise<boolean> {
    const id = this.idFor(slug)
    if (!id) {
      return false
    }
    const runtime = this.spaces.get(id)
    await db.delete(space).where(eq(space.id, id))
    this.spaces.delete(id)
    this.bySlug.delete(runtime?.slug ?? slug)
    // The graph, instance and alias rows cascade with the space; this drops
    // the in-memory mirror of them.
    for (const graph of runtime?.graphs.values() ?? []) {
      this.graphsByInstance.delete(graph.instanceId)
    }
    for (const [aliasSlug, aliasId] of this.aliasBySlug) {
      if (aliasId === id) {
        this.aliasBySlug.delete(aliasSlug)
      }
    }
    return true
  }

  // `expectedUpdatedAt`, when given, must match the graph row's current
  // `updatedAt` or the write is rejected (GraphConflictError) instead of
  // silently clobbering a newer save from another tab/tool call. The
  // condition is enforced by the UPDATE's WHERE clause so the
  // check-then-write is atomic even across concurrent requests.
  async saveGraph(address: string, graph: GraphData, expectedUpdatedAt?: string): Promise<GraphRef | null> {
    const ref = this.resolveGraph(address)
    if (!ref) {
      return null
    }
    // `updatedAt` is millisecond-precision, not a monotonic counter, so two
    // writers racing within the same millisecond — plus a third stale writer
    // whose expectedUpdatedAt happens to match — could theoretically both pass
    // this check. Accepted risk for v1: real writers are paced well above 1ms
    // (canvas autosave debounces 500ms, MCP tool calls run sequentially per
    // session). If conflict reports ever show writes slipping through, replace
    // this with a monotonic integer `version` column instead of tightening the
    // timestamp comparison.
    const condition = expectedUpdatedAt
      ? and(eq(spaceGraph.id, ref.graph.id), eq(spaceGraph.updatedAt, new Date(expectedUpdatedAt)))
      : eq(spaceGraph.id, ref.graph.id)
    const [row] = await db
      .update(spaceGraph)
      .set({ data: JSON.stringify(graph) })
      .where(condition)
      .returning()
    if (!row) {
      throw new GraphConflictError(address)
    }
    ref.graph.graph = graph
    ref.graph.updatedAt = row.updatedAt
    return ref
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

export type { GraphRef, GraphRuntime, SpaceRuntime }
