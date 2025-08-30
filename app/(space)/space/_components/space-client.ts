import type { GraphData, SpaceExport, SpaceSummary } from '@/app/(space)/server/types';

export async function fetchSpaceGraph(slug: string): Promise<GraphData> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(slug)}`, { cache: 'no-store' });
  if (!res.ok) {
    return { nodes: [], edges: [] };
  }
  const body = await res.json() as { graph: GraphData };
  return body.graph;
}

export async function saveSpaceGraph(slug: string, graph: GraphData): Promise<void> {
  await fetch(`/api/spaces/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph }),
  });
}

export async function listSpacesClient(): Promise<SpaceSummary[]> {
  const res = await fetch('/api/spaces', { cache: 'no-store' });
  const body = await res.json() as { spaces: SpaceSummary[] };
  return body.spaces;
}

export async function createSpaceClient(name: string): Promise<SpaceSummary> {
  const res = await fetch('/api/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await res.json() as { space: SpaceSummary };
  return body.space;
}

export async function renameSpaceClient(slug: string, name: string): Promise<SpaceSummary> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await res.json() as { space: SpaceSummary };
  return body.space;
}

export async function deleteSpaceClient(slug: string): Promise<boolean> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  return res.ok;
}

export async function importSpaceClient(payload: SpaceExport): Promise<SpaceSummary> {
  const res = await fetch('/api/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ import: payload }),
  });
  const body = await res.json() as { space: SpaceSummary };
  return body.space;
}
