import type { GraphData } from '@/app/(space)/server/types';

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
