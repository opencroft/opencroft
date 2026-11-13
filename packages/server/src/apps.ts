/**
 * `@opencroft/server/apps` — an App's server half. An extension that provides
 * Apps (see `AppEntry` in `@opencroft/core`) may export `apps` from its server
 * module — a map of each App's bare type to its hooks — to react to instances
 * of its Apps being added to, removed from, loaded and unloaded by the host,
 * and to serve their actions. `apps` here lists the instances.
 */
import type { HostAgentGroupChatsApi, HostGroupChatsApi, HostPersonGroupChatsApi } from './chat'
import type { HostUser } from './people'
import type { HostDirectoryChange, HostSpacesApi } from './spaces'
import type { HostUsageApi } from './usage'

/** One added App instance, as reported to the providing extension. */
export interface HostAppInstance {
  instanceId: string
  /** The App this is an instance of, by the bare type this extension declared it under — its key in `apps`. */
  type: string
  /** @deprecated Read `type`, which holds the same bare value. */
  appSlug: string
  spaceSlug: string
  /** The instance's display name — the host's field, required at add time. */
  name: string
  /** The instance's slug — unique in its space; `<spaceSlug>.<slug>` is its address. */
  slug: string
  params: Record<string, string>
  /** Absolute path of the instance's private data directory. */
  dataDir: string
}

/**
 * One added App instance of any extension, as a directory shows it: where it
 * is and how it is drawn. Never its parameters or its data directory, which
 * stay its own extension's (`listInstances`).
 */
export interface HostAppDirectoryEntry {
  /** `<spaceSlug>.<slug>`: what `app_call` and `callAppAction` take, and `/space/<spaceSlug>/app/<slug>` in the app. */
  address: string
  instanceId: string
  /** The App it is an instance of, qualified: `<owner>.<extension>.<type>`. */
  type: string
  /** The instance's own name, not the App's title. */
  name: string
  /** Unique in its space; a rename moves it, and with it the address. */
  slug: string
  spaceSlug: string
  /** Lucide icon name its App declares (`AppEntry.icon`); absent when it declares none or its extension is not installed. */
  icon?: string
  /** CSS colour its App declares (`AppEntry.accent`); absent when it declares none. */
  accent?: string
}

export interface HostAppsApi {
  /** The calling extension's added App instances, oldest first; optionally one App's only, named by its bare type. */
  listInstances(type?: string): Promise<HostAppInstance[]>
  /**
   * Every added App instance the viewer may see, of every extension, oldest
   * first; with `space`, one space's only (an unknown or unseen space lists
   * nothing). The viewer is the one `spaces.list` sees as
   * (`@opencroft/server/spaces`): the apps are those of its spaces. Read from
   * the stored instances, so it asks no App anything.
   */
  directory(options?: { space?: string }): Promise<HostAppDirectoryEntry[]>
  /**
   * Hear every change that can change what `directory` answers: an app added,
   * removed, renamed, moved or retyped, any change to a space (its apps'
   * addresses ride on its slug), or a grant that moved which spaces the
   * viewer sees. Read `directory` again to learn what changed. Returns the
   * unsubscribe, as `spaces.subscribe`.
   */
  subscribe(listener: (change: HostDirectoryChange) => void | Promise<void>): () => void
}

/**
 * The calling extension's own added App instances; `directory` as the
 * extension's own system identity.
 */
export declare const apps: HostAppsApi

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

/**
 * The context an App action runs in: the instance, plus who asked, when the
 * surface could name them. At most one of `callerAgent` and `callerPerson` is
 * set, and both are bound by the host — an extension cannot supply either.
 */
export interface AppActionContext extends AppInstanceContext {
  /** The agent that called, through `app_call`. */
  callerAgent?: string
  /**
   * The signed-in person, when the App's own UI called through
   * `callAppAction` (`@opencroft/client`). Taken from the session by the host,
   * never from anything the client sent.
   */
  callerPerson?: HostUser
  /**
   * Group chats acting as whoever this call is on behalf of: `callerAgent` when
   * an agent called — with `turns` for reading — and the extension's own
   * system identity otherwise, which cannot read. When a person called, the
   * extension's identity again, plus the person's own chats and the grant —
   * see `HostPersonGroupChatsApi`. Bound by the host for this one call and
   * unusable once it ends.
   */
  groupChats: HostGroupChatsApi | HostAgentGroupChatsApi | HostPersonGroupChatsApi
  /**
   * The spaces whoever this call is on behalf of may see: the calling person
   * or agent, else the extension's own system identity. Bound by the host for
   * this one call and unusable once it ends.
   */
  spaces: HostSpacesApi
  /** `apps`, with `directory` seeing what `spaces` sees. Bound like it. */
  apps: HostAppsApi
  /**
   * Spend summaries over the chats of whoever this call is on behalf of: the
   * calling person or agent, else the extension's own system identity. Bound
   * like `spaces`.
   */
  usage: HostUsageApi
  /**
   * Present when the action runs as a background task, and aborted when that
   * task is cancelled or times out. The host cannot stop a handler itself: one
   * that watches this ends early, one that ignores it runs to completion
   * regardless — which is why a cancel reports that it asked, not that it
   * stopped.
   */
  signal?: AbortSignal
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
   * What a person calls one of the App's live handle ids, for showing it in a
   * picker instead of the id -- e.g. a worktree's repository and name. Pure
   * and synchronous: it reads the id alone. Undefined leaves the id to the
   * host's own fallback.
   */
  handleLabel?: (handleId: string) => string | undefined
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

/** The `apps` export of an extension's server module, keyed by the bare type each App is declared under. */
export type AppsExport = Record<string, AppServerHooks>
