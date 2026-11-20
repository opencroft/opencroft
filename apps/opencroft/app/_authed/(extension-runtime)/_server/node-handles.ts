import type { DynamicHandleLister } from '@opencroft/server/graph'

import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

// The manifest fields this module reads. Structural rather than a concrete
// manifest type: callers reach manifests through different loaders (one plain,
// one a server fn) whose result types differ, and forcing them onto one loader
// would change what each currently sees.
interface ManifestLike {
  id: string
  nodes?: Array<{ type: string; name?: string; handles?: ExtensionHandle[] }>
}

export interface NodeTypeHandles {
  extensionId: string
  /** The type's display name, which a node nobody named goes by. */
  name?: string
  handles: ExtensionHandle[]
}

// Which extension owns each node type, and what handles that type declares.
// Pure, so each caller keeps its own manifest source while sharing the mapping.
//
// Keyed by the qualified type, which carries its extension's id, so two
// extensions declaring the same bare name land on two keys; the manifest
// normalization has already refused one extension declaring a name twice.
export function buildNodeTypeHandles(manifests: ManifestLike[]): Map<string, NodeTypeHandles> {
  const map = new Map<string, NodeTypeHandles>()
  for (const manifest of manifests) {
    for (const node of manifest.nodes ?? []) {
      map.set(node.type, { extensionId: manifest.id, name: node.name, handles: node.handles ?? [] })
    }
  }
  return map
}

/** The declared ids (prefixes) of the dynamic source handles among `declared`. */
export function dynamicSourcePrefixes(declared: ExtensionHandle[]): string[] {
  return declared.filter((handle) => handle.dynamic && handle.role === 'source').map((handle) => handle.id)
}

/** A node type's `dynamicHandles` entry, or undefined when it has none. */
export type DynamicHandleListerOf = (type: string | undefined) => Promise<DynamicHandleLister | undefined>

/**
 * A lookup of each node type's entry in its extension's `dynamicHandles`
 * export, loading each type's extension once, for one listing or one read. A
 * type whose extension declares no entry for it, is not installed or does not
 * load has none; a load that fails is logged, since every node of the type
 * then drops out of the pickers.
 *
 * Reaches the module through the loader, never a server fn: a handle listing
 * is reachable from an extension's Nitro route (`host.graph.listHandles`),
 * which has no TanStack Start request context for a server fn to run in.
 */
export function dynamicHandleListers(): DynamicHandleListerOf {
  const loaded = new Map<string, Promise<DynamicHandleLister | undefined>>()
  return (type) => {
    const parsed = type ? parseType(type) : null
    if (!type || !parsed) {
      return Promise.resolve(undefined)
    }
    let lister = loaded.get(type)
    if (!lister) {
      lister = import('@/app/_authed/(extension-runtime)/_server/loader')
        .then(({ getExtensionModule }) => getExtensionModule(parsed.extensionId))
        .then((module) => module.dynamicHandles?.[parsed.bare])
        .catch((err) => {
          console.error(`[node-handles] no dynamic handles for ${type}: its extension did not load:`, err)
          return undefined
        })
      loaded.set(type, lister)
    }
    return lister
  }
}

interface DynamicHandleNode {
  id: string
  type?: string
  data?: Record<string, unknown>
}

/**
 * The node's live ids under each of `prefixes`, as its type's `lister`
 * answers them: a declared dynamic handle is an id prefix, and the live ids
 * depend on the node. Only ids under the prefix asked are kept. [] with no
 * lister, and on failure (logged), so a single unreachable node can't fail a
 * whole enumeration.
 */
export async function expandDynamicHandles(
  node: DynamicHandleNode,
  prefixes: string[],
  lister: DynamicHandleLister | undefined,
): Promise<string[]> {
  if (!lister || prefixes.length === 0) {
    return []
  }
  try {
    const answers = await Promise.all(
      prefixes.map(async (prefix) => {
        const ids: unknown = await lister.list({ id: node.id, data: node.data ?? {} }, prefix)
        return Array.isArray(ids)
          ? ids.filter((id): id is string => typeof id === 'string' && id.startsWith(prefix))
          : []
      }),
    )
    return [...new Set(answers.flat())]
  } catch (err) {
    console.error(`[node-handles.expandDynamicHandles] failed for ${node.id}:`, err)
    return []
  }
}
