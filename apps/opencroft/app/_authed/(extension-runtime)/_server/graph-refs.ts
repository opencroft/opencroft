import { resolveAppAddress } from '@/app/_authed/(apps)/_server/app-address'
import { appHandleLabels } from '@/app/_authed/(apps)/_server/runtime'
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
  /**
   * Asked as a terminal target on an App instance: what the App calls that
   * handle (its `handleLabel` hook), keyed by handle id. Absent when the App
   * gives it no name, so the caller falls back to the id.
   */
  handleLabels?: Record<string, string>
}

// Across every space, since a reference (a terminal target, a route) can
// point outside the graph it is shown in. An id that is neither a graph node
// nor an App instance maps to null, so the caller can say "unknown" instead
// of guessing.
//
// Each ref is answered under the string it was asked as. A
// "<id>/<handle-id>" terminal target is described by its owner, and on an App
// also carries the App's name for that handle: only the App knows that a
// worktree handle's escaped id stands for "repo · worktree".
export async function describeGraphRefsImpl(ids: string[]): Promise<Record<string, GraphRefInfo | null>> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const result: Record<string, GraphRefInfo | null> = {}
  let spaceSlugById: Map<string, string> | undefined
  for (const asked of new Set(ids)) {
    const slash = asked.indexOf('/')
    const id = slash > 0 ? asked.slice(0, slash) : asked
    const handleId = slash > 0 ? asked.slice(slash + 1) : ''
    const ref = registry.findByNode(id)
    const node = ref?.graph.graph.nodes.find((n) => (n as { id?: string }).id === id) as
      | { type?: string; data?: Record<string, unknown> }
      | undefined
    if (ref && node) {
      const data = node.data ?? {}
      result[asked] = {
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
      const handleLabels = handleId ? await appHandleLabels(row, [handleId]) : {}
      result[asked] = {
        id,
        kind: 'app',
        type: `app:${row.type}`,
        name: row.name || row.type,
        spaceSlug: spaceSlugById.get(row.spaceId) ?? '',
        ...(Object.keys(handleLabels).length > 0 ? { handleLabels } : {}),
      }
      continue
    }
    result[asked] = null
  }
  return result
}
