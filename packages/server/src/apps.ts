/**
 * Server-side App lifecycle contracts. An extension that provides Apps (see
 * `AppEntry` in `@opencroft/core`) may export `apps` from its server module —
 * a map of app slug to hooks — to react to instances of its Apps being added
 * to, removed from, loaded and unloaded by the host.
 */

/** One added instance of an App, as handed to every lifecycle hook. */
export interface AppInstanceContext {
  /** Stable id of this instance — the same App can be added many times with different params. */
  instanceId: string
  /** Slug of the space the instance was added to. */
  spaceSlug: string
  /** The instance's display name — required at add time, editable later. */
  name: string
  /**
   * The instance's slug: derived from the name, unique within the space —
   * with the space it forms the instance's public address, `<space>.<slug>`.
   * A rename moves it; a transfer may re-slug it on collision in the target
   * space. So a context held from before a rename is stale.
   */
  slug: string
  /** The parameter values the user entered, keyed by parameter id. */
  params: Record<string, string>
  /**
   * Absolute path to this instance's private data directory. Created by the
   * host before `onAdded`, deleted by the host after `onRemoved`.
   */
  dataDir: string
}

/** The context an App action runs in: the instance, plus the agent that asked, when the surface could name one. */
export interface AppActionContext extends AppInstanceContext {
  callerAgent?: string
}

/**
 * One agent-invokable action of an App, dispatched by the host's `app_call`
 * MCP tool. Its metadata (description, input schema) is declared beside the
 * App entry in the manifest (`AppActionMeta` in `@opencroft/core`), keyed by
 * the same action id. String returns are shown as text; objects are
 * JSON-stringified.
 */
export type AppActionHandler = (ctx: AppActionContext, params: Record<string, unknown>) => unknown | Promise<unknown>

/**
 * Lifecycle hooks for one App. All optional. Order of events over an
 * instance's life: `onAdded` then `onLoad` when the user adds it; `onLoad`
 * for every existing instance at server start; `onUnload` at server stop;
 * `onUnload` then `onRemoved` when the user removes it (the data directory
 * is deleted after `onRemoved` returns).
 */
export interface AppServerHooks {
  onAdded?: (ctx: AppInstanceContext) => void | Promise<void>
  /**
   * The App's chance to REFUSE a removal before any teardown starts: a throw
   * here surfaces to the caller and nothing is unloaded or deleted. Distinct
   * from `onRemoved`, whose failures are logged and cannot keep the instance
   * -- by the time it runs, the removal is already happening.
   */
  beforeRemoved?: (ctx: AppInstanceContext) => void | Promise<void>
  onRemoved?: (ctx: AppInstanceContext) => void | Promise<void>
  /**
   * React to a parameter edit IN PLACE. An App that provides this keeps its
   * instance (and whatever data it owns) across the edit; without it the host
   * falls back to recreating the instance — unload, onRemoved, data directory
   * deleted, onAdded against the new values.
   */
  onUpdated?: (ctx: AppInstanceContext, previousParams: Record<string, string>) => void | Promise<void>
  /**
   * React to the instance being renamed. The name is the host's field, edited
   * in place — `ctx.name` already reads the new one, the slug has not moved —
   * so this exists only for an App that mirrors the name into data it owns
   * (the Graph App's graph row). Most Apps need nothing here.
   */
  onRenamed?: (ctx: AppInstanceContext, previousName: string) => void | Promise<void>
  /**
   * Follow the instance to another space. Called after the host moved the
   * instance's row — `ctx.spaceSlug` is already the TARGET space, and
   * `ctx.slug`/`ctx.name` already read what slug-collision resolution decided
   * for the new space — so the
   * App relocates whatever space-scoped data it owns; a throw here rolls the
   * move back and surfaces to the caller. The private data directory is keyed
   * by instance, not space, and needs nothing done.
   */
  onTransferred?: (ctx: AppInstanceContext, previousSpaceSlug: string) => void | Promise<void>
  onLoad?: (ctx: AppInstanceContext) => void | Promise<void>
  onUnload?: (ctx: AppInstanceContext) => void | Promise<void>
  /** Agent-invokable actions of this App, keyed by the manifest's action id. */
  actions?: Record<string, AppActionHandler>
  /**
   * Live ids for the App's `dynamic` handles (declared beside the App entry in
   * the manifest — `AppHandle` in `@opencroft/core`). Called on every handle
   * discovery, uncached, so the list tracks what actually exists right now.
   */
  listHandles?: (ctx: AppInstanceContext) => string[] | Promise<string[]>
  /**
   * The context value behind one of the App's handles. The handle is
   * addressed as `<instanceId>/<handleId>` wherever node targets are
   * accepted. Return undefined for an id this App does not expose.
   */
  getHandleContext?: (
    ctx: AppInstanceContext,
    handleId: string,
  ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
}

/** The `apps` export of an extension's server module, keyed by App slug. */
export type AppsExport = Record<string, AppServerHooks>
