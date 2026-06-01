import { createServerFn } from '@tanstack/react-start';

import { resolveGraphContexts } from '@/app/(extension-runtime)/_server/graph-context-resolver';
import { type GraphSnapshot } from '@/app/(extension-runtime)/_server/host';
import { slugify, uniqueSlug } from '@/app/(space)/server/slug';
import { getSpacesRegistry, type SpaceRuntime } from '@/app/(space)/server/store';
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

function toSummary(runtime: SpaceRuntime): SpaceSummary {
  return {
    id: runtime.id,
    slug: runtime.slug,
    name: runtime.name,
    pinned: runtime.pinned,
    createdAt: runtime.createdAt.toISOString(),
    updatedAt: runtime.updatedAt.toISOString(),
  };
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

export const listSpaces = createServerFn({ strict: { output: false } }).handler(async (): Promise<SpaceSummary[]> => {
  const r = await registry();
  return r.list();
});

export const loadSpaceGraph = createServerFn({ strict: { output: false } })
  .inputValidator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<GraphData | null> => {
    const r = await registry();
    const space = r.getBySlug(slug);
    if (!space) {
      return null;
    }
    return space.graph;
  });

export const saveSpaceGraph = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { slug: string; graph: GraphData }) => data)
  .handler(async ({ data }): Promise<void> => {
    const r = await registry();
    const resolved = await resolveGraph(data.graph);
    await r.saveGraph(data.slug, resolved);
  });

export const createSpace = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((name: string) => name)
  .handler(async ({ data: name }): Promise<SpaceSummary> => {
    const r = await registry();
    const trimmed = name.trim() || 'Space';
    const existing = new Set(r.list().map((s) => s.slug));
    const slug = uniqueSlug(slugify(trimmed), existing);
    const runtime = await r.create(trimmed, slug, { nodes: [], edges: [] });
    return toSummary(runtime);
  });

export const renameSpace = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { slug: string; name: string }) => data)
  .handler(async ({ data }): Promise<SpaceSummary | null> => {
    const r = await registry();
    const runtime = await r.rename(data.slug, data.name.trim() || 'Space');
    if (!runtime) {
      return null;
    }
    return toSummary(runtime);
  });

export const deleteSpace = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<boolean> => {
    const r = await registry();
    if (slug === DEFAULT_SPACE_SLUG && r.list().length <= 1) {
      return false;
    }
    return r.remove(slug);
  });

export const setSpacePinned = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { slug: string; pinned: boolean }) => data)
  .handler(async ({ data }): Promise<SpaceSummary | null> => {
    const r = await registry();
    const runtime = await r.setPinned(data.slug, data.pinned);
    if (!runtime) {
      return null;
    }
    return toSummary(runtime);
  });

export const exportSpace = createServerFn({ strict: { output: false } })
  .inputValidator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<SpaceExport | null> => {
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
  });

export const importSpace = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((payload: SpaceExport) => payload)
  .handler(async ({ data: payload }): Promise<SpaceSummary> => {
    const r = await registry();
    const existing = new Set(r.list().map((s) => s.slug));
    const desired = slugify(payload.slug || payload.name || 'space');
    const slug = uniqueSlug(desired, existing);
    const graph: GraphData = {
      nodes: Array.isArray(payload.graph?.nodes) ? payload.graph.nodes : [],
      edges: Array.isArray(payload.graph?.edges) ? payload.graph.edges : [],
    };
    const runtime = await r.create(payload.name || 'Imported', slug, graph);
    return toSummary(runtime);
  });

export const getActiveSpaceSlug = createServerFn({ strict: { output: false } }).handler(async (): Promise<string> => {
  const r = await registry();
  const active = await r.getActiveSlug();
  if (active) {
    return active;
  }
  const list = r.list();
  return list[0]?.slug ?? DEFAULT_SPACE_SLUG;
});

export const setActiveSpaceSlug = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<void> => {
    const r = await registry();
    if (!r.hasSlug(slug)) {
      return;
    }
    await r.setActiveSlug(slug);
  });

export const findSpaceByNode = createServerFn({ strict: { output: false } })
  .inputValidator((nodeId: string) => nodeId)
  .handler(async ({ data: nodeId }): Promise<SpaceSummary | null> => {
    const r = await registry();
    const space = r.findByNode(nodeId);
    if (!space) {
      return null;
    }
    return toSummary(space);
  });
