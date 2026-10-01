import { resolveAppAddress } from '@/app/_authed/(apps)/_server/app-address'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

/** What a node or App instance id stands for, for showing it by name. */
export interface GraphRefInfo {
  id: string
  kind: 'node' | 'app'
  /** The node's stored, qualified type, or `app:<type>` with the App's for an App instance. */
  type: string
  /** The name its owner gave it; '' when it has none (the caller falls back to the type's name). */
  name: string
  spaceSlug: string
}

// Across every space, since a reference (a terminal target, a route) can
// point outside the graph it is shown in. An id that is neither a graph node
// nor an App instance maps to null, so the caller can say "unknown" instead
// of guessing.
export async function describeGraphRefsImpl(ids: string[]): Promise<Record<string, GraphRefInfo | null>> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const result: Record<string, GraphRefInfo | null> = {}
  let spaceSlugById: Map<string, string> | undefined
  for (const id of new Set(ids)) {
    const ref = registry.findByNode(id)
    const node = ref?.graph.graph.nodes.find((n) => (n as { id?: string }).id === id) as
      | { type?: string; data?: Record<string, unknown> }
      | undefined
    if (ref && node) {
      const data = node.data ?? {}
      result[id] = {
        id,
        kind: 'node',
        type: node.type ?? '',
        name: (data.name as string) || (data.title as string) || '',
        spaceSlug: ref.space.slug,
      }
      continue
    }
    const row = await resolveAppAddress(id).catch(() => null)
    if (row) {
      spaceSlugById ??= new Map(registry.list().map((space) => [space.id, space.slug]))
      result[id] = {
        id,
        kind: 'app',
        type: `app:${row.type}`,
        name: row.name || row.type,
        spaceSlug: spaceSlugById.get(row.spaceId) ?? '',
      }
      continue
    }
    result[id] = null
  }
  return result
}
