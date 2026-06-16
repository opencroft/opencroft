import { listExtensionManifests } from '@/app/(extension-runtime)/_server/actions'
import type { GraphNodeRecord, GraphSnapshot } from '@/app/(extension-runtime)/_server/host'
import { getExtensionModule } from '@/app/(extension-runtime)/_server/loader'
import { type ExtensionHandle, findExtensionHandle } from '@/app/(extension-runtime)/_types'

interface ResolvedContextEntry {
  sourceNodeId: string
  sourceHandleId: string
  contextType: string
  value: unknown
}

const CONTEXT_KEY = '__resolvedContexts'

/**
 * Server-side graph context resolver.
 * Iterates all edges, calls exposeOutput on source nodes' server modules,
 * and writes resolved context into target nodes' data.
 */
export async function resolveGraphContexts(graph: GraphSnapshot): Promise<GraphSnapshot> {
  const manifests = await listExtensionManifests()
  const nodeTypeToExtension = new Map<string, { extensionId: string; handles: ExtensionHandle[] }>()
  for (const m of manifests) {
    if (!m.nodes) {
      continue
    }
    for (const node of m.nodes) {
      nodeTypeToExtension.set(node.typeId, { extensionId: m.id, handles: node.handles ?? [] })
    }
  }

  // Reset all __resolvedContexts
  const updatedNodes = graph.nodes.map((n) => {
    const { [CONTEXT_KEY]: _, ...rest } = n.data
    return { ...n, data: rest } as GraphNodeRecord
  })

  for (const edge of graph.edges) {
    const sourceNode = updatedNodes.find((n) => n.id === edge.source)
    const targetNode = updatedNodes.find((n) => n.id === edge.target)
    if (!sourceNode || !targetNode) {
      continue
    }
    if (!sourceNode.type || !edge.sourceHandle || !edge.targetHandle) {
      continue
    }

    const extInfo = nodeTypeToExtension.get(sourceNode.type)
    if (!extInfo) {
      continue
    }

    const sourceHandle = findExtensionHandle(extInfo.handles, edge.sourceHandle, 'source')
    if (!sourceHandle) {
      continue
    }
    const contextType = sourceHandle.contextType

    try {
      const mod = await getExtensionModule(extInfo.extensionId)
      const exposeOutput = (
        mod as {
          exposeOutput?: (
            handleId: string,
            nodeData: Record<string, unknown>,
            typeId: string,
            nodeId: string,
          ) => unknown
        }
      ).exposeOutput
      if (!exposeOutput) {
        continue
      }

      const value = exposeOutput(edge.sourceHandle, sourceNode.data, sourceNode.type, sourceNode.id)
      if (value === undefined || value === null) {
        continue
      }

      const targetIdx = updatedNodes.findIndex((n) => n.id === targetNode.id)
      if (targetIdx < 0) {
        continue
      }

      const contexts = (updatedNodes[targetIdx].data[CONTEXT_KEY] as Record<string, ResolvedContextEntry>) ?? {}
      contexts[edge.targetHandle] = {
        sourceNodeId: sourceNode.id,
        sourceHandleId: edge.sourceHandle,
        contextType,
        value,
      }
      updatedNodes[targetIdx] = {
        ...updatedNodes[targetIdx],
        data: { ...updatedNodes[targetIdx].data, [CONTEXT_KEY]: contexts },
      }
    } catch (err) {
      console.error(`[graph-resolver] failed to resolve context for edge ${edge.source}->${edge.target}:`, err)
    }
  }

  return { ...graph, nodes: updatedNodes }
}
