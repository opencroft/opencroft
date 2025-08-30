import {
  ACTIVE_SPACE_SETTING_ID,
  DEFAULT_SPACE_NAME,
  DEFAULT_SPACE_SLUG,
  type GraphData,
  LEGACY_GRAPH_SETTING_ID,
  type SpaceSummary,
} from '@/app/(space)/server/types';
import { prisma } from '@/server/prisma';

interface SpaceRuntime {
  id: string;
  slug: string;
  name: string;
  graph: GraphData;
  createdAt: Date;
  updatedAt: Date;
}

const EMPTY_GRAPH: GraphData = { nodes: [], edges: [] };

function parseGraph(data: string): GraphData {
  const parsed = JSON.parse(data) as Partial<GraphData>;
  return {
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
  };
}

class SpacesRegistry {
  private spaces = new Map<string, SpaceRuntime>();
  private bySlug = new Map<string, string>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    await this.migrateLegacyGraph();
    const rows = await prisma.space.findMany({ orderBy: { createdAt: 'asc' } });
    for (const row of rows) {
      const runtime: SpaceRuntime = {
        id: row.id,
        slug: row.slug,
        name: row.name,
        graph: parseGraph(row.data),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      this.spaces.set(row.id, runtime);
      this.bySlug.set(row.slug, row.id);
    }
    if (this.spaces.size === 0) {
      await this.createInternal(DEFAULT_SPACE_NAME, DEFAULT_SPACE_SLUG, EMPTY_GRAPH);
    }
    this.loaded = true;
  }

  private async migrateLegacyGraph(): Promise<void> {
    const existing = await prisma.space.findFirst();
    if (existing) {
      return;
    }
    const legacy = await prisma.setting.findUnique({ where: { id: LEGACY_GRAPH_SETTING_ID } });
    if (!legacy) {
      return;
    }
    const graph = parseGraph(legacy.data);
    await prisma.space.create({
      data: {
        slug: DEFAULT_SPACE_SLUG,
        name: DEFAULT_SPACE_NAME,
        data: JSON.stringify(graph),
      },
    });
  }

  private async createInternal(name: string, slug: string, graph: GraphData): Promise<SpaceRuntime> {
    const row = await prisma.space.create({
      data: { name, slug, data: JSON.stringify(graph) },
    });
    const runtime: SpaceRuntime = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      graph,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    this.spaces.set(runtime.id, runtime);
    this.bySlug.set(runtime.slug, runtime.id);
    return runtime;
  }

  list(): SpaceSummary[] {
    return [...this.spaces.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      }));
  }

  hasSlug(slug: string): boolean {
    return this.bySlug.has(slug);
  }

  getBySlug(slug: string): SpaceRuntime | null {
    const id = this.bySlug.get(slug);
    if (!id) {
      return null;
    }
    return this.spaces.get(id) ?? null;
  }

  getById(id: string): SpaceRuntime | null {
    return this.spaces.get(id) ?? null;
  }

  findByNode(nodeId: string): SpaceRuntime | null {
    for (const s of this.spaces.values()) {
      if (s.graph.nodes.some((n) => (n as { id?: string }).id === nodeId)) {
        return s;
      }
    }
    return null;
  }

  async create(name: string, slug: string, graph: GraphData): Promise<SpaceRuntime> {
    return this.createInternal(name, slug, graph);
  }

  async rename(slug: string, name: string): Promise<SpaceRuntime | null> {
    const id = this.bySlug.get(slug);
    if (!id) {
      return null;
    }
    const runtime = this.spaces.get(id)!;
    const row = await prisma.space.update({
      where: { id },
      data: { name },
    });
    runtime.name = row.name;
    runtime.updatedAt = row.updatedAt;
    return runtime;
  }

  async remove(slug: string): Promise<boolean> {
    const id = this.bySlug.get(slug);
    if (!id) {
      return false;
    }
    await prisma.space.delete({ where: { id } });
    this.spaces.delete(id);
    this.bySlug.delete(slug);
    return true;
  }

  async saveGraph(slug: string, graph: GraphData): Promise<SpaceRuntime | null> {
    const id = this.bySlug.get(slug);
    if (!id) {
      return null;
    }
    const runtime = this.spaces.get(id)!;
    const row = await prisma.space.update({
      where: { id },
      data: { data: JSON.stringify(graph) },
    });
    runtime.graph = graph;
    runtime.updatedAt = row.updatedAt;
    return runtime;
  }

  async setActiveSlug(slug: string): Promise<void> {
    await prisma.setting.upsert({
      where: { id: ACTIVE_SPACE_SETTING_ID },
      create: { id: ACTIVE_SPACE_SETTING_ID, data: JSON.stringify({ slug }) },
      update: { data: JSON.stringify({ slug }) },
    });
  }

  async getActiveSlug(): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { id: ACTIVE_SPACE_SETTING_ID } });
    if (!row) {
      return null;
    }
    const { slug } = JSON.parse(row.data) as { slug?: string };
    if (!slug || !this.bySlug.has(slug)) {
      return null;
    }
    return slug;
  }
}

const globalForSpaces = globalThis as unknown as { __SPACES_REGISTRY__?: SpacesRegistry };

export function getSpacesRegistry(): SpacesRegistry {
  if (!globalForSpaces.__SPACES_REGISTRY__) {
    globalForSpaces.__SPACES_REGISTRY__ = new SpacesRegistry();
  }
  return globalForSpaces.__SPACES_REGISTRY__;
}

export type { SpaceRuntime };
