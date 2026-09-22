import { resolveContexts } from '@/app/_authed/(extension-runtime)/_server/context-resolution'
import { listExtensionManifestsImpl } from '@/app/_authed/(extension-runtime)/_server/extension-action-impl'
import { type GraphSnapshot, resolveTerminalTarget } from '@/app/_authed/(extension-runtime)/_server/host'
import { getExtensionModule } from '@/app/_authed/(extension-runtime)/_server/loader'
import { buildNodeTypeHandles } from '@/app/_authed/(extension-runtime)/_server/node-handles'

/**
 * Server-side graph context resolver: resolves every edge's context through
 * the installed extensions' exposeOutput (see context-resolution for the
 * resolution itself) and writes the result into the target nodes' data.
 */
export async function resolveGraphContexts(graph: GraphSnapshot): Promise<GraphSnapshot> {
  // The -impl variant, not the server fn: this resolver runs from MCP calls,
  // the scheduler and other non-request contexts, where a TanStack Start
  // server fn has no Start context and does not return the manifest list.
  const nodeTypeToExtension = buildNodeTypeHandles(await listExtensionManifestsImpl())
  return resolveContexts(graph, {
    nodeTypeToExtension,
    exposeOutputOf: async (extensionId) => (await getExtensionModule(extensionId)).exposeOutput,
    resolveTerminalTarget,
  })
}
