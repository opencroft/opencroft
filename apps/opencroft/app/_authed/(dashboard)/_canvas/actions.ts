import { createServerFn } from '@tanstack/react-start'

import { resolveGraphContexts } from '@/app/_authed/(extension-runtime)/_server/graph-context-resolver'
import type { GraphSnapshot } from '@/app/_authed/(extension-runtime)/_server/host'
import { getSettingImpl, setSettingImpl } from '@/app/_authed/(settings)/_server/settings-impl'

const GRAPH_SETTING_ID = 'app-dashboard-mvp-graph'

export interface GraphData {
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}

export const loadGraph = createServerFn({ strict: { output: false } }).handler(async (): Promise<GraphData> => {
  const setting = (await getSettingImpl(GRAPH_SETTING_ID)) as { data: GraphData } | null
  return setting?.data ?? { nodes: [], edges: [] }
})

export const saveGraph = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: GraphData) => data)
  .handler(async ({ data }): Promise<void> => {
    // Resolve all exposeOutput contexts before saving
    const snapshot: GraphSnapshot = {
      nodes: data.nodes as unknown as GraphSnapshot['nodes'],
      edges: data.edges as unknown as GraphSnapshot['edges'],
    }
    const resolved = await resolveGraphContexts(snapshot)
    await setSettingImpl({
      id: GRAPH_SETTING_ID,
      data: {
        nodes: resolved.nodes as unknown as GraphData['nodes'],
        edges: resolved.edges as unknown as GraphData['edges'],
      },
    })
  })
