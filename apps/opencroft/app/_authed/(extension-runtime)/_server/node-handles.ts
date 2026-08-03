import { invokeExtensionActionImpl } from '@/app/_authed/(extension-runtime)/_server/extension-action-impl'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

// The manifest fields this module reads. Structural rather than a concrete
// manifest type: callers reach manifests through different loaders (one plain,
// one a server fn) whose result types differ, and forcing them onto one loader
// would change what each currently sees.
interface ManifestLike {
  id: string
  nodes?: Array<{ typeId: string; handles?: ExtensionHandle[] }>
}

export interface NodeTypeHandles {
  extensionId: string
  handles: ExtensionHandle[]
}

// Which extension owns each node type, and what handles that type declares.
// Pure, so each caller keeps its own manifest source while sharing the mapping.
export function buildNodeTypeHandles(manifests: ManifestLike[]): Map<string, NodeTypeHandles> {
  const map = new Map<string, NodeTypeHandles>()
  for (const manifest of manifests) {
    for (const node of manifest.nodes ?? []) {
      map.set(node.typeId, { extensionId: manifest.id, handles: node.handles ?? [] })
    }
  }
  return map
}

interface DynamicHandleNode {
  id: string
  type?: string
  data?: Record<string, unknown>
}

// The extension owning the 'docker' node type, or null. Resolved once by the
// caller and passed to expandDynamicHandles, rather than re-derived per node.
export function findDockerExtensionId(manifests: ManifestLike[]): string | null {
  return manifests.find((m) => m.nodes?.some((n) => n.typeId === 'docker'))?.id ?? null
}

// Live ids for a node's dynamic source handles — a declared dynamic handle is
// an id PREFIX, and the concrete ids only exist at runtime (one per running
// container). Returns [] for anything with no dynamic source handle, and on
// failure, so a single unreachable node can't fail a whole enumeration.
//
// Application-node/docker specific today, which is why it lives in one place:
// when another node type grows dynamic handles, this is the function that
// learns about it rather than each caller.
//
// Reaches the docker action through the plain impl, NOT the createServerFn in
// _server/actions.ts. The server fn needs TanStack Start's request-scoped
// AsyncLocalStorage, which an extension's Nitro route never establishes — and
// this is reachable from one, via host.graph.listHandles. Using the server fn
// here would throw "No Start context found" for exactly those nodes that have
// a container to expand, i.e. it would read as "some sources are missing"
// rather than as an error. See the route-context test beside this file.
export async function expandDynamicHandles(
  node: DynamicHandleNode,
  declared: ExtensionHandle[],
  dockerExtensionId: string | null,
): Promise<string[]> {
  if (node.type !== 'application') {
    return []
  }
  const dynamic = declared.find((h) => h.dynamic && h.role === 'source')
  if (!dynamic) {
    // A dynamic handle that isn't a source has no expansion path — say so
    // rather than returning [] as though the node simply had none, which
    // would look like "this source disappeared".
    if (declared.some((h) => h.dynamic)) {
      console.error(
        `[node-handles] node type "${node.type}" declares a dynamic handle that is not role:'source'; expansion only supports dynamic sources`,
      )
    }
    return []
  }
  const resolved = node.data?.__resolvedContexts as Record<string, { sourceNodeId?: string }> | undefined
  const dockerNodeId = resolved?.['docker-in']?.sourceNodeId
  if (!dockerNodeId || !dockerExtensionId) {
    return []
  }
  const service = (node.data?.name as string) || node.id
  try {
    const containers = (await invokeExtensionActionImpl({
      extensionId: dockerExtensionId,
      actionName: 'docker.ps',
      args: [{ dockerNodeId, service }],
    })) as Array<{
      id: string
      name: string
      running: boolean
    }>
    return containers.filter((c) => c.running).map((c) => `${dynamic.id}${c.name || c.id}`)
  } catch (err) {
    console.error(`[node-handles.expandDynamicHandles] failed for ${node.id}:`, err)
    return []
  }
}
