import { invokeExtensionAction } from '@/app/(extension-runtime)/_server/actions'
import { loadAllManifests } from '@/app/(extension-runtime)/_server/loader'
import type { ExtensionHandle } from '@/app/(extension-runtime)/_types'

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

// Live ids for a node's dynamic source handles — a declared dynamic handle is
// an id PREFIX, and the concrete ids only exist at runtime (one per running
// container). Returns [] for anything with no dynamic source handle, and on
// failure, so a single unreachable node can't fail a whole enumeration.
//
// Application-node/docker specific today, which is why it lives in one place:
// when another node type grows dynamic handles, this is the function that
// learns about it rather than each caller.
export async function expandDynamicHandles(node: DynamicHandleNode, declared: ExtensionHandle[]): Promise<string[]> {
  if (node.type !== 'application') {
    return []
  }
  const dynamic = declared.find((h) => h.dynamic && h.role === 'source')
  if (!dynamic) {
    return []
  }
  const resolved = node.data?.__resolvedContexts as Record<string, { sourceNodeId?: string }> | undefined
  const dockerNodeId = resolved?.['docker-in']?.sourceNodeId
  if (!dockerNodeId) {
    return []
  }
  const service = (node.data?.name as string) || node.id
  try {
    const manifests = await loadAllManifests()
    const owning = manifests.find((m) => m.nodes?.some((n) => n.typeId === 'docker'))
    if (!owning) {
      return []
    }
    const containers = (await invokeExtensionAction({
      data: { extensionId: owning.id, actionName: 'docker.ps', args: [{ dockerNodeId, service }] },
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
