import type { ComponentType } from 'react'

/** A dashboard provided by an extension, routed at /dashboard/[slug]. */
export interface DashboardDefinition {
  slug: string
  title: string
  description?: string
  component: ComponentType
}

/**
 * Server-known dashboard metadata, read from the extension manifest before any
 * client bundle loads. The React `component` is NOT part of it — that lives in
 * the client bundle and is resolved from the registry only on the detail page.
 */
export interface DashboardMeta {
  slug: string
  title: string
  description?: string
  extensionId: string
}
