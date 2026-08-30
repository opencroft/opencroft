import { createServerFn } from '@tanstack/react-start'

import type { Setting } from '@/app/_authed/(settings)/_server/setting'
import { getSettingImpl, setSettingImpl } from '@/app/_authed/(settings)/_server/settings-impl'

const GRAPH_SETTING_ID = 'app-dashboard-graph'

export interface GraphData {
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}

export const loadGraph = createServerFn({ strict: { output: false } }).handler(async (): Promise<GraphData> => {
  const setting = (await getSettingImpl(GRAPH_SETTING_ID)) as Setting<GraphData> | null
  return setting?.data ?? { nodes: [], edges: [] }
})

export const saveGraph = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: GraphData) => data)
  .handler(async ({ data }): Promise<void> => {
    await setSettingImpl({ id: GRAPH_SETTING_ID, data })
  })
