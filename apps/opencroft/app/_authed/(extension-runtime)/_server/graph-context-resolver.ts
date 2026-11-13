import { enumCasesOfManifests } from '@/app/_authed/(extension-runtime)/_enum-types'
import { withFollowedTypes } from '@/app/_authed/(extension-runtime)/_input-types'
import { resolveContexts } from '@/app/_authed/(extension-runtime)/_server/context-resolution'
import { listExtensionManifestsImpl } from '@/app/_authed/(extension-runtime)/_server/extension-action-impl'
import { type GraphSnapshot, resolveTerminalTarget } from '@/app/_authed/(extension-runtime)/_server/host'
import { getExtensionModule } from '@/app/_authed/(extension-runtime)/_server/loader'
import { buildNodeTypeHandles } from '@/app/_authed/(extension-runtime)/_server/node-handles'

/**
 * Server-side graph context resolver: resolves every edge's context through
 * the installed extensions' exposeOutput (see context-resolution for the
 * resolution itself) and writes the result into the target nodes' data.
 * First, every input that takes several types takes the type of what feeds
 * it now (see `withFollowedTypes`), so the contexts are read through the
 * types the graph has.
 *
 * `runEvents` are the events of the run the resolution serves, by the node
 * that dispatched each; the producers' run-time outputs answer from them.
 * Without them, as for every resolution that is stored, they expose nothing.
 */
export async function resolveGraphContexts(
  graph: GraphSnapshot,
  runEvents?: ReadonlyMap<string, unknown>,
): Promise<GraphSnapshot> {
  // The -impl variant, not the server fn: this resolver runs from MCP calls,
  // the scheduler and other non-request contexts, where a TanStack Start
  // server fn has no Start context and does not return the manifest list.
  const manifests = await listExtensionManifestsImpl()
  const nodeTypeToExtension = buildNodeTypeHandles(manifests)
  const enumCasesOf = enumCasesOfManifests(manifests)
  const followed = withFollowedTypes(graph, (type) => nodeTypeToExtension.get(type)?.handles ?? [], enumCasesOf)
  return resolveContexts(followed, {
    nodeTypeToExtension,
    exposeOutputOf: async (extensionId) => (await getExtensionModule(extensionId)).exposeOutput,
    enumCasesOf,
    resolveTerminalTarget,
    ...(runEvents ? { runEventOf: (nodeId: string) => runEvents.get(nodeId) } : {}),
  })
}
