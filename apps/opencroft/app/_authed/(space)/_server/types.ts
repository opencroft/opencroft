import { coreType } from '@/app/_authed/(extension-runtime)/_core-types'

export interface GraphData {
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}

export interface SpaceSummary {
  id: string
  slug: string
  name: string
  pinned: boolean
  /** `preset:<glyph>:<colour>`, or a small square image as a base64 data URL. */
  icon: string
  createdAt: string
  updatedAt: string
}

export const DEFAULT_SPACE_NAME = 'Default'
export const DEFAULT_SPACE_SLUG = 'default'
export const LEGACY_GRAPH_SETTING_ID = 'app-dashboard-mvp-graph'

// The host-registered Graph App: every graph in a space is one instance of
// it, the migration that turns a space's legacy single graph into rows
// creates instances of it, and its server hooks own the graph lifecycle.
// Declared by core, so this is core's type in the form an instance stores.
export const GRAPH_APP_TYPE = coreType('graph')
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
