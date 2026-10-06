import type { LiveGraphSession } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

export interface SpaceGraphResult {
  graph: GraphData
  updatedAt: string | null
  /** Where to open the graph's document; null when the graph could not be fetched. */
  live: LiveGraphSession | null
}

export async function fetchSpaceGraph(slug: string): Promise<SpaceGraphResult> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(slug)}`, { cache: 'no-store' })
  if (!res.ok) {
    return { graph: { nodes: [], edges: [] }, updatedAt: null, live: null }
  }
  return (await res.json()) as SpaceGraphResult
}
