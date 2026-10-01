import type { AppEntry } from '@opencroft/core'

/**
 * Server-known App metadata, read from the extension manifest's
 * `provides.apps` before any client bundle loads, so a list of Apps renders
 * server-side. The React `component` is not part of it; that lives in the
 * client bundle (`AppDefinition` in @opencroft/client).
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
  /** The App this is an instance of: its qualified type, which names the providing extension. */
  type: string
  /**
   * Whether anything provides the App now. False while its extension is not
   * installed: the instance keeps its parameters and data, and shows which
   * extension it is waiting for.
   */
  provided: boolean
  /** The instance's display name — required, editable, and the slug follows it. */
  name: string
  /**
   * The instance's slug — unique in the space; `<space>.<slug>` is its address.
   * Minted from the name and re-minted on rename, so an address
   * outlives neither the label nor a rename. A rename onto a taken slug is refused.
   */
  slug: string
  params: Record<string, string>
  createdAt: string
  updatedAt: string
}
