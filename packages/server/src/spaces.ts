/**
 * `@opencroft/server/spaces` — the spaces a caller may see, for a launcher, a
 * dashboard or a picker. Metadata only: what a space is called and how it is
 * drawn, never what it holds.
 */

/** One space, as a directory shows it. */
export interface HostSpace {
  /** The space's address: `/space/<slug>` in the app, and the first part of every `<space>.<app>` address. */
  slug: string
  name: string
  /** `preset:<glyph>:<colour>` from the design kit's Space Icon presets, or a small square image as a data URL. */
  icon: string
}

/**
 * The spaces one viewer may see. Imported from this module, the viewer is the
 * extension's own system identity, which sees the spaces whose chat it was
 * granted into (`grantExtension` in `@opencroft/server/chat`, or the chat's
 * members dialog). An App action's `ctx.spaces` and a session route's
 * `context.spaces` see what the caller sees: a person or an agent, every
 * space they are in.
 */
export interface HostSpacesApi {
  /** The viewer's spaces, by name. */
  list(): Promise<HostSpace[]>
  /**
   * Hear every change that can change what `list` answers: a space added,
   * removed, renamed or with a new icon, or a grant that moved which spaces
   * the viewer sees. Read `list` again to learn what changed. Returns the
   * unsubscribe. A subscription made from the server module ends when the
   * module is unloaded, and one made through a copy bound to a call ends with
   * the call, whether or not the extension unsubscribed.
   */
  subscribe(listener: (change: HostDirectoryChange) => void | Promise<void>): () => void
}

/**
 * What kind of thing in the directory changed, and how; never which one, so a
 * listener learns nothing its viewer's listing would not tell it. `access` is
 * a grant into or out of a space's chat. `moved` is an app transferred to
 * another space; `updated` any other change a listing shows.
 */
export interface HostDirectoryChange {
  subject: 'space' | 'app' | 'access'
  change: 'added' | 'removed' | 'renamed' | 'moved' | 'updated'
}

/** The spaces the extension's own system identity may see. */
export declare const spaces: HostSpacesApi
