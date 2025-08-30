'use server';

import { resolveGraphContexts } from '@/app/(extension-runtime)/_server/graph-context-resolver';
import { type GraphSnapshot } from '@/app/(extension-runtime)/_server/host';
import { slugify, uniqueSlug } from '@/app/(space)/server/slug';
import { getSpacesRegistry } from '@/app/(space)/server/store';
import {
  DEFAULT_SPACE_SLUG,
  type GraphData,
  type SpaceExport,
  type SpaceSummary,
} from '@/app/(space)/server/types';

async function registry() {
  const r = getSpacesRegistry();
  await r.ensureLoaded();
  return r;
}

async function resolveGraph(graph: GraphData): Promise<GraphData> {
  const snapshot: GraphSnapshot = {
    nodes: graph.nodes as unknown as GraphSnapshot['nodes'],
    edges: graph.edges as unknown as GraphSnapshot['edges'],
  };
  const resolved = await resolveGraphContexts(snapshot);
  return {
    nodes: resolved.nodes as unknown as GraphData['nodes'],
    edges: resolved.edges as unknown as GraphData['edges'],
  };
}

export async function listSpaces(): Promise<SpaceSummary[]> {
  const r = await registry();
  return r.list();
}

export async function loadSpaceGraph(slug: string): Promise<GraphData | null> {
  const r = await registry();
  const space = r.getBySlug(slug);
  if (!space) {
    return null;
  }
  return space.graph;
}

export async function saveSpaceGraph(slug: string, data: GraphData): Promise<void> {
  const r = await registry();
  const resolved = await resolveGraph(data);
  await r.saveGraph(slug, resolved);
}

export async function createSpace(name: string): Promise<SpaceSummary> {
  const r = await registry();
  const trimmed = name.trim() || 'Space';
  const existing = new Set(r.list().map((s) => s.slug));
  const slug = uniqueSlug(slugify(trimmed), existing);
  const runtime = await r.create(trimmed, slug, { nodes: [], edges: [] });
  return {
    id: runtime.id,
    slug: runtime.slug,
    name: runtime.name,
    createdAt: runtime.createdAt.toISOString(),
    updatedAt: runtime.updatedAt.toISOString(),
  };
}

export async function renameSpace(slug: string, name: string): Promise<SpaceSummary | null> {
  const r = await registry();
  const runtime = await r.rename(slug, name.trim() || 'Space');
  if (!runtime) {
    return null;
  }
  return {
    id: runtime.id,
    slug: runtime.slug,
    name: runtime.name,
    createdAt: runtime.createdAt.toISOString(),
    updatedAt: runtime.updatedAt.toISOString(),
  };
}

export async function deleteSpace(slug: string): Promise<boolean> {
  const r = await registry();
  if (slug === DEFAULT_SPACE_SLUG && r.list().length <= 1) {
    return false;
  }
  return r.remove(slug);
}

export async function exportSpace(slug: string): Promise<SpaceExport | null> {
  const r = await registry();
  const space = r.getBySlug(slug);
  if (!space) {
    return null;
  }
  return {
    name: space.name,
    slug: space.slug,
    graph: space.graph,
    exportedAt: new Date().toISOString(),
  };
}

export async function importSpace(payload: SpaceExport): Promise<SpaceSummary> {
  const r = await registry();
  const existing = new Set(r.list().map((s) => s.slug));
  const desired = slugify(payload.slug || payload.name || 'space');
  const slug = uniqueSlug(desired, existing);
  const graph: GraphData = {
    nodes: Array.isArray(payload.graph?.nodes) ? payload.graph.nodes : [],
    edges: Array.isArray(payload.graph?.edges) ? payload.graph.edges : [],
  };
  const runtime = await r.create(payload.name || 'Imported', slug, graph);
  return {
    id: runtime.id,
    slug: runtime.slug,
    name: runtime.name,
    createdAt: runtime.createdAt.toISOString(),
    updatedAt: runtime.updatedAt.toISOString(),
  };
}

export async function getActiveSpaceSlug(): Promise<string> {
  const r = await registry();
  const active = await r.getActiveSlug();
  if (active) {
    return active;
  }
  const list = r.list();
  return list[0]?.slug ?? DEFAULT_SPACE_SLUG;
}

export async function setActiveSpaceSlug(slug: string): Promise<void> {
  const r = await registry();
  if (!r.hasSlug(slug)) {
    return;
  }
  await r.setActiveSlug(slug);
}

export async function findSpaceByNode(nodeId: string): Promise<SpaceSummary | null> {
  const r = await registry();
  const space = r.findByNode(nodeId);
  if (!space) {
    return null;
  }
  return {
    id: space.id,
    slug: space.slug,
    name: space.name,
    createdAt: space.createdAt.toISOString(),
    updatedAt: space.updatedAt.toISOString(),
  };
}
