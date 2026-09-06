export interface GraphData {
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}

export interface SpaceSummary {
  id: string
  slug: string
  name: string
  pinned: boolean
  /** Small square image as a base64 data URL; null = no icon (render the default). */
  icon: string | null
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

// The host-registered Graph App: every graph in a space is one instance of
// it, the migration that turns a space's legacy single graph into rows
// creates instances of it, and its server hooks own the graph lifecycle.
export const GRAPH_APP_EXTENSION_ID = 'builtin/core'
export const GRAPH_APP_SLUG = 'graph'
export const DEFAULT_GRAPH_SLUG = 'default'
export const DEFAULT_GRAPH_NAME = 'Default'

/**
 * A graph address: `<space>` (the space's default graph) or
 * `<space>.<graph>`. Unambiguous because slugs never contain dots.
 */
export function parseGraphAddress(address: string): { spaceSlug: string; graphSlug: string | null } {
  const dot = address.indexOf('.')
  if (dot === -1) {
    return { spaceSlug: address, graphSlug: null }
  }
  return { spaceSlug: address.slice(0, dot), graphSlug: address.slice(dot + 1) }
}
