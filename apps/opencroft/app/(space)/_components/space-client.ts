import type { GraphData } from '@/app/(space)/_server/types'

export interface SpaceGraphResult {
  graph: GraphData
  updatedAt: string | null
}

export async function fetchSpaceGraph(slug: string): Promise<SpaceGraphResult> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(slug)}`, { cache: 'no-store' })
  if (!res.ok) {
    return { graph: { nodes: [], edges: [] }, updatedAt: null }
  }
  return (await res.json()) as SpaceGraphResult
}

export type SaveSpaceGraphResult =
  | { ok: true; updatedAt: string }
  | { ok: false; conflict: true }
  | { ok: false; conflict: false }

export async function saveSpaceGraph(
  slug: string,
  graph: GraphData,
  expectedUpdatedAt: string | null,
): Promise<SaveSpaceGraphResult> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph, expectedUpdatedAt: expectedUpdatedAt ?? undefined }),
  })
  if (res.status === 409) {
    return { ok: false, conflict: true }
  }
  if (!res.ok) {
    return { ok: false, conflict: false }
  }
  const body = (await res.json()) as { updatedAt: string }
  return { ok: true, updatedAt: body.updatedAt }
}
