import { nodeName } from '@opencroft/core/values'

import { resolveAppAddress } from '@/app/_authed/(apps)/_server/app-address'
import { appHandleNames } from '@/app/_authed/(apps)/_server/runtime'
import type { NodeTypeHandles } from '@/app/_authed/(extension-runtime)/_server/node-handles'
import { terminalDetail, terminalTitle } from '@/app/_authed/(extension-runtime)/_server/terminal-names'
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
  /** The space's name as its people see it; '' when the space is gone. */
  spaceName: string
  /** For a node: the graph it is on, by its address (`<spaceSlug>.<graph>`) and name. */
  graph?: { address: string; name: string }
  /** For an App instance: its slug, and its address `<spaceSlug>.<slug>` when its space exists. */
  slug?: string
  address?: string
  /**
   * Asked as a terminal target: which of the owner's terminals it is, when
   * that needs saying (see `terminalDetail`), and the terminal's one name
   * (see `terminalTitle`).
   */
  detail?: string
  title?: string
}

// Node types' declared handles, read only when a node's terminal target is
// asked: naming a plain node id needs no manifest. Imported on use, as host.ts
// does, since the manifest loader reaches back into the host.
async function nodeTypeHandles(): Promise<Map<string, NodeTypeHandles>> {
  const { listExtensionManifestsImpl } = await import('@/app/_authed/(extension-runtime)/_server/extension-action-impl')
  const { buildNodeTypeHandles } = await import('@/app/_authed/(extension-runtime)/_server/node-handles')
  return buildNodeTypeHandles(await listExtensionManifestsImpl())
}

// Across every space, since a reference (a terminal target, a route) can
// point outside the graph it is shown in. An id that is neither a graph node
// nor an App instance maps to null, so the caller can say "unknown" instead
// of guessing.
//
// Each ref is answered under the string it was asked as. A
// "<id>/<handle-id>" terminal target is described by its owner, with the
// terminal's name: only the host knows what tells a node's terminals apart,
// and only the App that a worktree handle's escaped id stands for
// "repo · worktree".
export async function describeGraphRefsImpl(ids: string[]): Promise<Record<string, GraphRefInfo | null>> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const result: Record<string, GraphRefInfo | null> = {}
  let spaces: Map<string, { slug: string; name: string }> | undefined
  let byType: Promise<Map<string, NodeTypeHandles>> | undefined
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
      const type = node.type ?? ''
      const info: GraphRefInfo = {
        id,
        kind: 'node',
        type,
        name: (data.name as string) || (data.title as string) || '',
        spaceSlug: ref.space.slug,
        spaceName: ref.space.name,
        graph: { address: registry.addressOf(ref), name: ref.graph.name },
      }
      if (handleId) {
        byType ??= nodeTypeHandles()
        const declared = (await byType).get(type)
        const sources = (declared?.handles ?? []).filter((handle) => handle.role === 'source')
        const detail = terminalDetail(sources, handleId)
        if (detail) {
          info.detail = detail
        }
        info.title = terminalTitle({ kind: 'node', name: nodeName(data, declared?.name, type) }, detail)
      }
      result[asked] = info
      continue
    }
    const row = await resolveAppAddress(id).catch(() => null)
    if (row) {
      spaces ??= new Map(registry.list().map((space) => [space.id, { slug: space.slug, name: space.name }]))
      const space = spaces.get(row.spaceId)
      const named = handleId ? (await appHandleNames(row, [handleId]))[handleId] : undefined
      result[asked] = {
        id,
        kind: 'app',
        type: `app:${row.type}`,
        name: row.name || row.type,
        spaceSlug: space?.slug ?? '',
        spaceName: space?.name ?? '',
        slug: row.slug,
        ...(space ? { address: `${space.slug}.${row.slug}` } : {}),
        ...(named ? { ...(named.detail ? { detail: named.detail } : {}), title: named.title } : {}),
      }
      continue
    }
    result[asked] = null
  }
  return result
}
