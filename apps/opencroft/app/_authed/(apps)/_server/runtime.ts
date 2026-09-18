// The host side of the App instance lifecycle (see AppServerHooks in
// @opencroft/server): which instances are live in this process, their private
// data directories, and the dispatch of onAdded/onRemoved/onLoad/onUnload to
// the providing extension's server module.
//
// Load state lives on globalThis for the same reason the startup flag does:
// a dev-server module reload must not forget which instances already ran
// onLoad, or a reloaded module would load them a second time.

import { promises as fs } from 'node:fs'

import type { AppActionMeta, AppEntry, AppHandle } from '@opencroft/core'
import { db, spaceApp } from '@opencroft/db'
import type { AppInstanceContext, AppServerHooks } from '@opencroft/server'
import { asc, eq } from 'drizzle-orm'

import { resolveAppAddress } from '@/app/_authed/(apps)/_server/app-address'
import { graphAppHooks } from '@/app/_authed/(apps)/_server/graph-app'
import { appInstanceDataDir } from '@/app/_authed/(apps)/_server/instance-paths'
import { getExtensionModule } from '@/app/_authed/(extension-runtime)/_server/loader'
import { getProvided } from '@/app/_authed/(extension-runtime)/_server/provides'
import { registry } from '@/app/_authed/(space)/_server/actions-impl'
import { instanceSlugFor } from '@/app/_authed/(space)/_server/slug'
import { GRAPH_APP_EXTENSION_ID, GRAPH_APP_SLUG } from '@/app/_authed/(space)/_server/types'
import { registerShutdownStep } from '@/server/shutdown'

type SpaceAppRow = typeof spaceApp.$inferSelect

interface LoadedInstance {
  extensionId: string
  appSlug: string
  ctx: AppInstanceContext
}

const globalForApps = globalThis as unknown as {
  __spaceAppsLoaded?: Map<string, LoadedInstance>
  __spaceAppsStarted?: boolean
}

function loadedInstances(): Map<string, LoadedInstance> {
  return (globalForApps.__spaceAppsLoaded ??= new Map())
}

// Host-implemented apps first: their hooks are app code (they reach host
// internals an extension server bundle cannot see), while their metadata and
// client component still ship through the providing extension like any other
// App's. Everything else resolves through the extension's server module.
const hostAppHooks: Record<string, Record<string, AppServerHooks>> = {
  [GRAPH_APP_EXTENSION_ID]: { [GRAPH_APP_SLUG]: graphAppHooks },
}

async function hooksFor(extensionId: string, appSlug: string): Promise<AppServerHooks | undefined> {
  const hostHooks = hostAppHooks[extensionId]?.[appSlug]
  if (hostHooks) {
    return hostHooks
  }
  const mod = await getExtensionModule(extensionId)
  return mod.apps?.[appSlug]
}

async function instanceContext(row: SpaceAppRow): Promise<AppInstanceContext> {
  const r = await registry()
  const space = r.list().find((s) => s.id === row.spaceId)
  return {
    instanceId: row.id,
    spaceSlug: space?.slug ?? '',
    name: row.name,
    slug: row.slug,
    params: JSON.parse(row.params) as Record<string, string>,
    dataDir: appInstanceDataDir(row.extensionId, row.id),
  }
}

async function loadInstance(row: SpaceAppRow): Promise<void> {
  if (loadedInstances().has(row.id)) {
    return
  }
  const ctx = await instanceContext(row)
  await fs.mkdir(ctx.dataDir, { recursive: true })
  const hooks = await hooksFor(row.extensionId, row.appSlug)
  await hooks?.onLoad?.(ctx)
  loadedInstances().set(row.id, { extensionId: row.extensionId, appSlug: row.appSlug, ctx })
}

/**
 * The add flow: create the data directory, fire onAdded, then load. Throws
 * when a hook throws — the caller owns the row and rolls it back, so a
 * failed onAdded (e.g. a clone of an unreachable repository) does not leave
 * a half-configured instance behind.
 */
export async function handleInstanceAdded(row: SpaceAppRow): Promise<void> {
  const ctx = await instanceContext(row)
  await fs.mkdir(ctx.dataDir, { recursive: true })
  const hooks = await hooksFor(row.extensionId, row.appSlug)
  await hooks?.onAdded?.(ctx)
  await hooks?.onLoad?.(ctx)
  loadedInstances().set(row.id, { extensionId: row.extensionId, appSlug: row.appSlug, ctx })
}

/**
 * The App's veto on a removal, checked BEFORE any teardown: a throw here
 * propagates and nothing has been touched yet. Runs ahead of
 * handleInstanceRemoved in every removal flow, because that one deliberately
 * swallows hook failures -- by then the removal is already under way.
 */
export async function handleInstanceBeforeRemoved(row: SpaceAppRow): Promise<void> {
  const hooks = await hooksFor(row.extensionId, row.appSlug)
  await hooks?.beforeRemoved?.(await instanceContext(row))
}

/**
 * The remove flow: unload if loaded, fire onRemoved, delete the data
 * directory. Hook failures are logged, not rethrown — the user asked for the
 * instance to be gone, and a hook that cannot say goodbye does not get to
 * keep it. An App that must be able to REFUSE does it in beforeRemoved.
 */
export async function handleInstanceRemoved(row: SpaceAppRow): Promise<void> {
  const ctx = await instanceContext(row)
  try {
    const hooks = await hooksFor(row.extensionId, row.appSlug)
    if (loadedInstances().has(row.id)) {
      await hooks?.onUnload?.(ctx)
    }
    await hooks?.onRemoved?.(ctx)
  } catch (error) {
    console.error(`[apps] remove hooks failed for ${row.extensionId}/${row.appSlug} (${row.id})`, error)
  }
  loadedInstances().delete(row.id)
  await fs.rm(ctx.dataDir, { recursive: true, force: true })
}

/**
 * The edit flow: an instance's parameters are not patched in place — the
 * instance is RECREATED. Unload, onRemoved, delete the data directory, store
 * the new parameters, then run the add flow again (onAdded + onLoad against
 * an empty data dir). The row id survives, so links and the sidebar keep
 * working; the app's stored data deliberately does not.
 *
 * A failing re-init throws like a failing add, but there is nothing to roll
 * back TO — the old data is already gone — so the row keeps the new
 * parameters and the caller surfaces the error; editing again (or the next
 * boot's self-healing onLoad) retries.
 */
export async function handleInstanceRecreated(row: SpaceAppRow, params: string): Promise<SpaceAppRow> {
  await handleInstanceRemoved(row)
  const [updated] = await db
    .update(spaceApp)
    .set({ params, updatedAt: new Date() })
    .where(eq(spaceApp.id, row.id))
    .returning()
  await handleInstanceAdded(updated)
  return updated
}

/**
 * A parameter edit, routed by what the App can do: an App with an onUpdated
 * hook keeps its instance and data and reacts in place; anything else gets
 * the recreate flow above. The row is updated BEFORE the hook runs so the
 * hook's context already reads the new values; the previous ones ride along
 * as its second argument.
 */
export async function handleInstanceUpdated(row: SpaceAppRow, params: string): Promise<SpaceAppRow> {
  const hooks = await hooksFor(row.extensionId, row.appSlug)
  if (!hooks?.onUpdated) {
    return handleInstanceRecreated(row, params)
  }
  const previousParams = JSON.parse(row.params) as Record<string, string>
  const [updated] = await db
    .update(spaceApp)
    .set({ params, updatedAt: new Date() })
    .where(eq(spaceApp.id, row.id))
    .returning()
  await hooks.onUpdated(await instanceContext(updated), previousParams)
  const loaded = loadedInstances().get(row.id)
  if (loaded) {
    loaded.ctx = await instanceContext(updated)
  }
  return updated
}

/** Whether an App's server hooks react to parameter edits in place — see AppMeta.updatesInPlace. */
export async function appUpdatesInPlace(extensionId: string, appSlug: string): Promise<boolean> {
  try {
    return Boolean((await hooksFor(extensionId, appSlug))?.onUpdated)
  } catch {
    // A server module that does not build answers as "recreates" — the safe
    // reading, since that is what the edit flow will actually do.
    return false
  }
}

/**
 * Move one instance to another space: the row first, then the App's
 * onTransferred hook so it relocates whatever space-scoped data it owns. A
 * throwing hook rolls the row back and rethrows, so a refused transfer
 * leaves the instance exactly where it was. Session-free by design -- the
 * space-settings UI and the MCP surface both land here.
 *
 * The SLUG survives when the target has it free. When it clashes, the
 * instance keeps its OWN name and slug and takes a numbered suffix instead
 * -- "OpenCroft" arriving beside a target that already has an "opencroft"
 * becomes "OpenCroft 2" / `opencroft-2`, incremented until the target has no
 * sibling holding it. The hook's context reads the resolved name and slug,
 * so an App mirroring them into its own data (the Graph App) follows along.
 */
export async function transferSpaceAppImpl(ref: string, targetSpaceSlug: string): Promise<SpaceAppRow> {
  const r = await registry()
  const target = r.getBySlug(targetSpaceSlug)
  if (!target) {
    throw new Error(`Unknown space: ${targetSpaceSlug}`)
  }
  const row = await resolveAppAddress(ref)
  if (!row) {
    throw new Error(`Unknown app instance: ${ref}`)
  }
  if (row.spaceId === target.id) {
    return row
  }
  const previousSpace = r.list().find((s) => s.id === row.spaceId)
  const targetRows = await db.query.spaceApp.findMany({ where: eq(spaceApp.spaceId, target.id) })
  const taken = new Set(targetRows.map((sibling) => sibling.slug))
  let slug = row.slug
  let name = row.name
  if (taken.has(slug)) {
    let i = 2
    while (taken.has(`${slug}-${i}`)) {
      i += 1
    }
    slug = `${slug}-${i}`
    name = `${row.name} ${i}`
  }
  const [moved] = await db
    .update(spaceApp)
    .set({ spaceId: target.id, slug, name, updatedAt: new Date() })
    .where(eq(spaceApp.id, row.id))
    .returning()
  try {
    const hooks = await hooksFor(row.extensionId, row.appSlug)
    await hooks?.onTransferred?.(await instanceContext(moved), previousSpace?.slug ?? '')
  } catch (error) {
    await db
      .update(spaceApp)
      .set({ spaceId: row.spaceId, slug: row.slug, name: row.name })
      .where(eq(spaceApp.id, row.id))
    throw error
  }
  const loaded = loadedInstances().get(row.id)
  if (loaded) {
    loaded.ctx = await instanceContext(moved)
  }
  // Handed back, because the reference the CALLER used may no longer name this
  // instance: an address names it through its space, so the address that
  // reached here stops resolving the moment the move lands. A caller that
  // wants to say anything about the instance afterwards has to be given the
  // row rather than left holding a string that was true a moment ago.
  return moved
}

/** Fire onUnload for every loaded instance — the shutdown half of startSpaceApps. */
async function unloadAllInstances(): Promise<void> {
  for (const [instanceId, loaded] of loadedInstances()) {
    try {
      const hooks = await hooksFor(loaded.extensionId, loaded.appSlug)
      await hooks?.onUnload?.(loaded.ctx)
    } catch (error) {
      console.error(`[apps] unload failed for ${loaded.extensionId}/${loaded.appSlug} (${instanceId})`, error)
    }
  }
  loadedInstances().clear()
}

/**
 * One App as the catalog reports it to agents: what can be added, and the
 * parameters an add takes. Compact by design — this is what
 * `app_find` prints into an agent's context.
 */
export interface AppCatalogEntry {
  extensionId: string
  appSlug: string
  title: string
  description?: string
  parameters: Array<{ id: string; label: string; required?: boolean; description?: string }>
}

/** Every App any extension provides — what an `app_add` can instantiate. */
export async function listAppCatalog(): Promise<AppCatalogEntry[]> {
  const provided = await getProvided<AppEntry>('apps')
  return provided.map(({ extensionId, value }) => ({
    extensionId,
    appSlug: value.slug,
    title: value.title,
    description: value.description,
    parameters: (value.parameters ?? []).map((spec) => ({
      id: spec.id,
      label: spec.label,
      required: spec.required,
      description: spec.description,
    })),
  }))
}

/**
 * Thrown by `addSpaceAppImpl` when the name slugifies onto an instance the
 * space already has. A refusal rather than a silent suffix: the slug is the
 * instance's public address, and handing back a suffixed one would leave it
 * answering to an address nobody named.
 */
export class AppSlugTakenError extends Error {
  constructor(readonly address: string) {
    super(`An app already answers to "${address}" in this space. Pick a different name.`)
    this.name = 'AppSlugTakenError'
  }
}

/**
 * Add one App instance to a space — the session-free core the addSpaceApp
 * server function and the `app_add` MCP tool share. Every instance is NAMED:
 * the name is required, and its slug — derived once, here — must be free in
 * the space (AppSlugTakenError otherwise). Parameter values are kept only
 * for parameters the App declares, trimmed, empty values dropped; declared
 * `required` parameters must be non-empty. The instance is only kept if the
 * App accepts it: a throwing onAdded/onLoad hook rolls the row and its data
 * directory back and rethrows.
 */
export async function addSpaceAppImpl(
  spaceSlug: string,
  extensionId: string,
  appSlug: string,
  name: string,
  input?: Record<string, string>,
): Promise<SpaceAppRow> {
  const r = await registry()
  const space = r.getBySlug(spaceSlug)
  if (!space) {
    throw new Error(`Unknown space: ${spaceSlug}`)
  }
  const provided = await getProvided<AppEntry>('apps')
  const entry = provided.find((p) => p.extensionId === extensionId && p.value.slug === appSlug)?.value
  if (!entry) {
    throw new Error(`No extension provides app: ${extensionId}/${appSlug}`)
  }
  const trimmedName = name.trim()
  if (!trimmedName) {
    throw new Error('Every app instance needs a name')
  }
  const slug = instanceSlugFor(trimmedName)
  const siblings = await db.query.spaceApp.findMany({ where: eq(spaceApp.spaceId, space.id) })
  if (siblings.some((sibling) => sibling.slug === slug)) {
    throw new AppSlugTakenError(`${space.slug}.${slug}`)
  }
  const params: Record<string, string> = {}
  for (const spec of entry.parameters ?? []) {
    const value = input?.[spec.id]?.trim() ?? ''
    if (spec.required && !value) {
      throw new Error(`Missing required parameter: ${spec.label}`)
    }
    if (value) {
      params[spec.id] = value
    }
  }
  const [row] = await db
    .insert(spaceApp)
    .values({ spaceId: space.id, extensionId, appSlug, name: trimmedName, slug, params: JSON.stringify(params) })
    .returning()
  try {
    await handleInstanceAdded(row)
  } catch (error) {
    await db.delete(spaceApp).where(eq(spaceApp.id, row.id))
    await fs.rm(appInstanceDataDir(row.extensionId, row.id), { recursive: true, force: true })
    throw error
  }
  return row
}

/**
 * Remove one instance — the session-free core the removeSpaceApp server
 * function and the `app_remove` MCP tool share. The App's beforeRemoved veto
 * runs first, against an untouched instance, and propagates; after it the
 * teardown (unload, onRemoved, data directory, row) goes through whatever
 * happens. Returns false when the instance does not exist.
 */
export async function removeSpaceAppImpl(ref: string): Promise<boolean> {
  const row = await resolveAppAddress(ref)
  if (!row) {
    return false
  }
  await handleInstanceBeforeRemoved(row)
  await handleInstanceRemoved(row)
  await db.delete(spaceApp).where(eq(spaceApp.id, row.id))
  return true
}

/**
 * Rename one instance: the display name only — the slug is an address, fixed
 * at creation, and never moves with the label. Apps that mirror the name into
 * data they own (the Graph App's graph row) react through onRenamed.
 */
export async function renameSpaceAppImpl(instanceId: string, name: string): Promise<SpaceAppRow> {
  const trimmedName = name.trim()
  if (!trimmedName) {
    throw new Error('Every app instance needs a name')
  }
  const row = await db.query.spaceApp.findFirst({ where: eq(spaceApp.id, instanceId) })
  if (!row) {
    throw new Error(`Unknown app instance: ${instanceId}`)
  }
  if (row.name === trimmedName) {
    return row
  }
  const [updated] = await db
    .update(spaceApp)
    .set({ name: trimmedName, updatedAt: new Date() })
    .where(eq(spaceApp.id, row.id))
    .returning()
  const hooks = await hooksFor(row.extensionId, row.appSlug)
  await hooks?.onRenamed?.(await instanceContext(updated), row.name)
  const loaded = loadedInstances().get(row.id)
  if (loaded) {
    loaded.ctx = await instanceContext(updated)
  }
  return updated
}

/**
 * One instance as the MCP surface reports it to agents: identity, the space
 * it lives in, its parameter values, and the actions its App declares in the
 * manifest. Compact by design — this is what `app_list` prints into an
 * agent's context.
 */
export interface SpaceAppInfo {
  /**
   * The instance's PUBLIC ADDRESS, `<space>.<slug>` — what a caller spends to
   * reach it, and the only identifier this listing hands out.
   *
   * The uuid is deliberately absent. It still resolves everywhere the address
   * does and always will, but an agent spends what the listings give it, so
   * emitting the uuid here is what kept it in circulation. Acceptance is not
   * vocabulary; emission is.
   */
  address: string
  extensionId: string
  appSlug: string
  /** The instance's own name — what the user called it, not the App's title. */
  name: string
  /** The instance's slug — with `space` it forms `address`. */
  slug: string
  title: string
  description?: string
  space: string
  params: Record<string, string>
  actions: AppActionMeta[]
}

/** Every added instance, optionally narrowed to one space slug. */
export async function listSpaceAppInfos(spaceSlug?: string): Promise<SpaceAppInfo[]> {
  const rows = await db.query.spaceApp.findMany({ orderBy: asc(spaceApp.createdAt) })
  const r = await registry()
  const slugById = new Map(r.list().map((s) => [s.id, s.slug]))
  const provided = await getProvided<AppEntry>('apps')
  const infos: SpaceAppInfo[] = []
  for (const row of rows) {
    const space = slugById.get(row.spaceId) ?? ''
    if (spaceSlug && space !== spaceSlug) {
      continue
    }
    const entry = provided.find((p) => p.extensionId === row.extensionId && p.value.slug === row.appSlug)?.value
    infos.push({
      address: `${space}.${row.slug}`,
      extensionId: row.extensionId,
      appSlug: row.appSlug,
      name: row.name,
      slug: row.slug,
      title: entry?.title ?? row.appSlug,
      description: entry?.description,
      space,
      params: JSON.parse(row.params) as Record<string, string>,
      actions: entry?.actions ?? [],
    })
  }
  return infos
}

/**
 * One live handle of one App instance — the App analogue of a node's
 * `HandleInfo`, addressed as `<space>.<app-slug>/<handleId>`, or by the
 * identity form `<instanceId>/<handleId>`. Only sources exist:
 * an App consumes contexts through its parameters, not through edges.
 */
export interface AppHandleInfo {
  instanceId: string
  spaceSlug: string
  appSlug: string
  /** The App's title — what a picker shows in the node-name position. */
  title: string
  /** The live id; for a dynamic declaration, an expanded runtime id. */
  handleId: string
  /** The manifest id — the prefix form for a dynamic declaration. */
  declaredId: string
  contextType: string
  label?: string
  dynamic: boolean
}

/**
 * Every live handle every App instance exposes, with dynamic declarations
 * expanded through the extension's `listHandles` hook. Uncached for the same
 * reason node handle discovery is: expansion asks each App what exists right
 * now. One instance failing to expand is logged and skipped, not fatal.
 */
export async function listAppHandles(contextType?: string): Promise<AppHandleInfo[]> {
  const rows = await db.query.spaceApp.findMany({ orderBy: asc(spaceApp.createdAt) })
  if (rows.length === 0) {
    return []
  }
  const r = await registry()
  const slugById = new Map(r.list().map((s) => [s.id, s.slug]))
  const provided = await getProvided<AppEntry>('apps')
  const results: AppHandleInfo[] = []
  for (const row of rows) {
    const entry = provided.find((p) => p.extensionId === row.extensionId && p.value.slug === row.appSlug)?.value
    const declared = (entry?.handles ?? []).filter(
      (handle) => contextType === undefined || handle.contextType === contextType,
    )
    if (declared.length === 0) {
      continue
    }
    const base = {
      instanceId: row.id,
      spaceSlug: slugById.get(row.spaceId) ?? '',
      appSlug: row.appSlug,
      title: entry?.title ?? row.appSlug,
    }
    let liveIds: string[] = []
    if (declared.some((handle) => handle.dynamic)) {
      try {
        const hooks = await hooksFor(row.extensionId, row.appSlug)
        liveIds = (await hooks?.listHandles?.(await instanceContext(row))) ?? []
      } catch (error) {
        console.error(`[apps] listHandles failed for ${row.extensionId}/${row.appSlug} (${row.id})`, error)
        continue
      }
    }
    for (const handle of declared) {
      if (!handle.dynamic) {
        results.push({ ...base, ...handleFields(handle, handle.id) })
        continue
      }
      for (const liveId of liveIds.filter((id) => id.startsWith(handle.id))) {
        results.push({ ...base, ...handleFields(handle, liveId) })
      }
    }
  }
  return results
}

function handleFields(handle: AppHandle, liveId: string) {
  return {
    handleId: liveId,
    declaredId: handle.id,
    contextType: handle.contextType,
    label: handle.label,
    dynamic: Boolean(handle.dynamic),
  }
}

/**
 * The context value behind `<space>.<app-slug>/<handleId>` or the identity form
 * `<instanceId>/<handleId>`, via the extension's `getHandleContext` hook. Both
 * spellings converge in `resolveAppAddress`, so there is one definition of what
 * an app reference means and no caller has to know which form it was handed.
 *
 * Undefined when the reference names no App instance, the App declares no
 * handles, or the hook does not recognize the handle — callers fall through to
 * (or from) node resolution on it, and owe the DOTTED form a loud failure
 * instead, because a node id never contains a dot.
 */
export async function resolveAppHandleContext(
  ref: string,
  handleId: string,
): Promise<{ value: Record<string, unknown>; spaceSlug: string } | undefined> {
  const row = await resolveAppAddress(ref)
  if (!row) {
    return undefined
  }
  const hooks = await hooksFor(row.extensionId, row.appSlug)
  if (!hooks?.getHandleContext) {
    return undefined
  }
  const ctx = await instanceContext(row)
  const value = await hooks.getHandleContext(ctx, handleId)
  return value ? { value, spaceSlug: ctx.spaceSlug } : undefined
}

/**
 * Dispatch one App action against one instance — the `app_call` MCP tool's code
 * path. Takes either spelling of an app reference; see `resolveAppAddress`.
 */
export async function callAppAction(
  ref: string,
  actionId: string,
  params: Record<string, unknown>,
  callerAgent?: string,
): Promise<unknown> {
  const row = await resolveAppAddress(ref)
  if (!row) {
    throw new Error(`Unknown app instance: ${ref}`)
  }
  const hooks = await hooksFor(row.extensionId, row.appSlug)
  const handler = hooks?.actions?.[actionId]
  if (!handler) {
    throw new Error(`App ${row.extensionId}/${row.appSlug} has no action "${actionId}"`)
  }
  const ctx = { ...(await instanceContext(row)), callerAgent }
  return handler(ctx, params)
}

/**
 * Boot half of the lifecycle: load every stored instance and register the
 * matching unload as a shutdown step. Idempotent; called from server startup.
 * One instance failing to load (e.g. its extension does not build) is logged
 * and does not keep the others down.
 */
export async function startSpaceApps(): Promise<void> {
  if (globalForApps.__spaceAppsStarted) {
    return
  }
  globalForApps.__spaceAppsStarted = true
  registerShutdownStep(unloadAllInstances)
  // The registry first, deliberately: its load runs the one-time migration
  // that turns legacy per-space graphs into Graph App instances, and those
  // rows must exist before this enumeration or they miss their first onLoad.
  await registry()
  const rows = await db.query.spaceApp.findMany({ orderBy: asc(spaceApp.createdAt) })
  for (const row of rows) {
    try {
      await loadInstance(row)
    } catch (error) {
      console.error(`[apps] load failed for ${row.extensionId}/${row.appSlug} (${row.id})`, error)
    }
  }
}
