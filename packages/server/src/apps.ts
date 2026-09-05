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
  onRemoved?: (ctx: AppInstanceContext) => void | Promise<void>
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
