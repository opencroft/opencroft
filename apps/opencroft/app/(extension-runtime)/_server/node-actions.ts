// Client-reachable (imported by _client/host.ts): createServerFn exports
// ONLY. TanStack's client-build code splitting elides a handler *body*, not
// this file's own top-level imports — a single plain export here keeps those
// imports "live" for the client bundle too, and can silently reintroduce
// a client-bundle build break. Plain server-only helpers go in
// node-actions-impl.ts instead.
import { createServerFn } from '@tanstack/react-start'

import { loadAllManifests } from '@/app/(extension-runtime)/_server/loader'
import { dispatchNodeActionImpl, findNodeWithGraph } from '@/app/(extension-runtime)/_server/node-actions-impl'
import type { NodeActionDescriptor } from '@/app/(extension-runtime)/_types'

export const listNodeActions = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((nodeId: string) => nodeId)
  .handler(async ({ data: nodeId }): Promise<NodeActionDescriptor[]> => {
    const found = await findNodeWithGraph(nodeId)
    if (!found || !found.node.type) {
      return []
    }
    const manifests = await loadAllManifests()
    for (const manifest of manifests) {
      const meta = manifest.nodes?.find((n) => n.typeId === found.node.type)
      if (!meta?.actions) {
        continue
      }
      return meta.actions.map((a) => ({
        nodeId,
        typeId: found.node.type ?? '',
        extensionId: manifest.id,
        actionId: a.id,
        label: a.label,
        description: a.description,
        inputSchema: a.inputSchema,
      }))
    }
    return []
  })

// Client-callable wrapper — see node-actions-impl.ts's dispatchNodeActionImpl for why
// the plain implementation lives in its own module, separate from this file.
export const dispatchNodeAction = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { nodeId: string; actionId: string; params?: Record<string, unknown> }) => data)
  .handler(async ({ data }): Promise<unknown> => dispatchNodeActionImpl(data))
