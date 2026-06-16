import { db, space } from '@opencroft/db'
import { asc, eq } from 'drizzle-orm'

import {
  ACTIVE_SPACE_SETTING_ID,
  DEFAULT_SPACE_NAME,
  DEFAULT_SPACE_SLUG,
  type GraphData,
  LEGACY_GRAPH_SETTING_ID,
  type SpaceSummary,
} from '@/app/(space)/_server/types'
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
    db.insert(space)
      .values({
        slug: DEFAULT_SPACE_SLUG,
        name: DEFAULT_SPACE_NAME,
        data: JSON.stringify(graph),
      })
      .run()
  }

  private async createInternal(name: string, slug: string, graph: GraphData): Promise<SpaceRuntime> {
    const row = db
      .insert(space)
      .values({ name, slug, data: JSON.stringify(graph) })
      .returning()
      .get()
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

  hasSlug(slug: string): boolean {
    return this.bySlug.has(slug)
  }

  getBySlug(slug: string): SpaceRuntime | null {
    const id = this.bySlug.get(slug)
    if (!id) {
      return null
    }
    return this.spaces.get(id) ?? null
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
    const row = db.update(space).set({ pinned }).where(eq(space.id, id)).returning().get()
    runtime.pinned = row.pinned
    runtime.updatedAt = row.updatedAt
    return runtime
  }

  async rename(slug: string, name: string): Promise<SpaceRuntime | null> {
    const id = this.bySlug.get(slug)
    if (!id) {
      return null
    }
    const runtime = this.spaces.get(id)!
    const row = db.update(space).set({ name }).where(eq(space.id, id)).returning().get()
    runtime.name = row.name
    runtime.updatedAt = row.updatedAt
    return runtime
  }

  async remove(slug: string): Promise<boolean> {
    const id = this.bySlug.get(slug)
    if (!id) {
      return false
    }
    db.delete(space).where(eq(space.id, id)).run()
    this.spaces.delete(id)
    this.bySlug.delete(slug)
    return true
  }

  async saveGraph(slug: string, graph: GraphData): Promise<SpaceRuntime | null> {
    const id = this.bySlug.get(slug)
    if (!id) {
      return null
    }
    const runtime = this.spaces.get(id)!
    const row = db
      .update(space)
      .set({ data: JSON.stringify(graph) })
      .where(eq(space.id, id))
      .returning()
      .get()
    runtime.graph = graph
    runtime.updatedAt = row.updatedAt
    return runtime
  }

  async setActiveSlug(slug: string): Promise<void> {
    await upsertSetting(ACTIVE_SPACE_SETTING_ID, JSON.stringify({ slug }))
  }

  async getActiveSlug(): Promise<string | null> {
    const row = await getSetting(ACTIVE_SPACE_SETTING_ID)
    if (!row) {
      return null
    }
    const { slug } = JSON.parse(row.data) as { slug?: string }
    if (!slug || !this.bySlug.has(slug)) {
      return null
    }
    return slug
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
