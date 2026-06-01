export interface GraphData {
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}

export interface SpaceSummary {
  id: string
  slug: string
  name: string
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export interface SpaceExport {
  name: string
  slug: string
  graph: GraphData
  exportedAt: string
}

export const DEFAULT_SPACE_NAME = 'Default'
export const DEFAULT_SPACE_SLUG = 'default'
export const LEGACY_GRAPH_SETTING_ID = 'app-dashboard-mvp-graph'
export const ACTIVE_SPACE_SETTING_ID = 'active-space-slug'
