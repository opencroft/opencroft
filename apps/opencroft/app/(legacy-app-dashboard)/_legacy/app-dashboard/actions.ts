import { createServerFn } from '@tanstack/react-start'

import { getSetting, setSetting } from '@/app/(settings)/_server/actions'
import type { Setting } from '@/app/(settings)/_server/setting'

const GRAPH_SETTING_ID = 'app-dashboard-graph'

export interface GraphData {
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}

export const loadGraph = createServerFn({ strict: { output: false } }).handler(async (): Promise<GraphData> => {
  const setting = (await getSetting({ data: GRAPH_SETTING_ID })) as Setting<GraphData> | null
  return setting?.data ?? { nodes: [], edges: [] }
})

export const saveGraph = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: GraphData) => data)
  .handler(async ({ data }): Promise<void> => {
    await setSetting({ data: { id: GRAPH_SETTING_ID, data } })
  })
