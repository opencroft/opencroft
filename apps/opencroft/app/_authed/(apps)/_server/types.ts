import type { AppEntry } from '@opencroft/core'

/**
 * Server-known App metadata, read from the extension manifest's
 * `provides.apps` before any client bundle loads — same split as
 * DashboardMeta vs DashboardDefinition. The React `component` is not part of
 * it; that lives in the client bundle.
 */
export interface AppMeta extends AppEntry {
  extensionId: string
  /**
   * The App's server module reacts to parameter edits in place (onUpdated):
   * saving new values keeps the instance and its data, so the edit UI can
   * skip the recreate warning.
   */
  updatesInPlace?: boolean
}

/** An App added to a space, with the parameter values the user entered. */
export interface SpaceAppInstance {
  id: string
  extensionId: string
  appSlug: string
  params: Record<string, string>
  createdAt: string
  updatedAt: string
}
