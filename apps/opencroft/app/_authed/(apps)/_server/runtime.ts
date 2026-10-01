// The host side of the App instance lifecycle (see AppServerHooks in
// @opencroft/server): which instances are live in this process, their private
// data directories, and the dispatch of onAdded/onRemoved/onLoad/onUnload to
// the providing extension's server module.
//
// Load state lives on globalThis for the same reason the startup flag does:
// a dev-server module reload must not forget which instances already ran
// onLoad, or a reloaded module would load them a second time.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { AppActionMeta, AppEntry, AppHandle } from '@opencroft/core'
import { db, spaceApp } from '@opencroft/db'
import type { AppInstanceContext, AppServerHooks } from '@opencroft/server'
import { asc, eq } from 'drizzle-orm'

import { appAddressOf, isAppAddress, resolveAppAddress } from '@/app/_authed/(apps)/_server/app-address'
import { hostAppHooks, providedApps } from '@/app/_authed/(apps)/_server/host-apps'
import { appInstanceDataDir } from '@/app/_authed/(apps)/_server/instance-paths'
import { extensionIdOfType, parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import type { AppActionCaller } from '@/app/_authed/(extension-runtime)/_server/host'
import { getExtensionModule } from '@/app/_authed/(extension-runtime)/_server/loader'
import type { Provided } from '@/app/_authed/(extension-runtime)/_server/provides'
import { registry } from '@/app/_authed/(space)/_server/actions-impl'
import { instanceSlugFor } from '@/app/_authed/(space)/_server/slug'
import { registerShutdownStep } from '@/server/shutdown'

type SpaceAppRow = typeof spaceApp.$inferSelect

interface LoadedInstance {
  type: string
  ctx: AppInstanceContext
}

const globalForApps = globalThis as unknown as {
  __spaceAppsLoaded?: Map<string, LoadedInstance>
  __spaceAppsStarted?: boolean
}

function loadedInstances(): Map<string, LoadedInstance> {
  return (globalForApps.__spaceAppsLoaded ??= new Map())
}

/**
 * Whether an App type is provided right now: by a host App, or by an installed
 * extension whose manifest declares it. An instance whose type is not is in the
 * missing-extension state — a state, not an error: it keeps its row and its
 * data, runs no hooks, and comes back as it was once its extension is
 * installed again.
 */
async function isProvided(type: string): Promise<boolean> {
  return (await providedApps()).some((entry) => entry.value.type === type)
}

// Host-implemented apps first (see host-apps.ts); everything else resolves
// through the providing extension's server module, which keys its hooks by
// the bare type it declared. Undefined for an App nothing provides, so no
// caller has to tell a missing extension from an App without hooks.
async function hooksFor(type: string): Promise<AppServerHooks | undefined> {
  const hostHooks = hostAppHooks(type)
  if (hostHooks) {
    return hostHooks
  }
  const parsed = parseType(type)
  if (!parsed || !(await isProvided(type))) {
    return undefined
  }
  const mod = await getExtensionModule(parsed.extensionId)
  return mod.apps?.[parsed.bare]
}

/** Why an action cannot run on an instance whose App nothing provides: its extension, named. */
function missingProviderMessage(row: SpaceAppRow): string {
  const extensionId = extensionIdOfType(row.type)
  return extensionId
    ? `"${row.name}" is an app of type ${row.type}, which nothing provides: its extension ${extensionId} is not installed, or no longer declares it.`
    : `"${row.name}" is an app of type ${row.type}, which no extension provides.`
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
    dataDir: instanceDataDir(row.type, row.id),
  }
}

// Keyed by the extension the type names; a type that names none (stored
// before types were qualified) keeps its directory under the whole type.
function instanceDataDir(type: string, instanceId: string): string {
  return appInstanceDataDir(extensionIdOfType(type) ?? type, instanceId)
}

async function loadInstance(row: SpaceAppRow): Promise<void> {
  if (loadedInstances().has(row.id)) {
    return
  }
  const ctx = await instanceContext(row)
  await fs.mkdir(ctx.dataDir, { recursive: true })
  const hooks = await hooksFor(row.type)
  await hooks?.onLoad?.(ctx)
  loadedInstances().set(row.id, { type: row.type, ctx })
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
  const hooks = await hooksFor(row.type)
  await hooks?.onAdded?.(ctx)
  await hooks?.onLoad?.(ctx)
  loadedInstances().set(row.id, { type: row.type, ctx })
}

/**
 * The App's veto on a removal, checked BEFORE any teardown: a throw here
 * propagates and nothing has been touched yet. Runs ahead of
 * handleInstanceRemoved in every removal flow, because that one deliberately
 * swallows hook failures -- by then the removal is already under way.
 */
export async function handleInstanceBeforeRemoved(row: SpaceAppRow): Promise<void> {
  const hooks = await hooksFor(row.type)
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
    const hooks = await hooksFor(row.type)
    if (loadedInstances().has(row.id)) {
      await hooks?.onUnload?.(ctx)
    }
    await hooks?.onRemoved?.(ctx)
  } catch (error) {
    console.error(`[apps] remove hooks failed for ${row.type} (${row.id})`, error)
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
  const hooks = await hooksFor(row.type)
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
export async function appUpdatesInPlace(type: string): Promise<boolean> {
  try {
    return Boolean((await hooksFor(type))?.onUpdated)
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
    const hooks = await hooksFor(row.type)
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
  for (const instanceId of [...loadedInstances().keys()]) {
    await unloadInstance(instanceId)
  }
}

/**
 * One App as the catalog reports it to agents: what can be added, and the
 * parameters an add takes. Compact by design — this is what
 * `app_find` prints into an agent's context.
 */
export interface AppCatalogEntry {
  /** The App's qualified type — what `app_add` takes. */
  type: string
  title: string
  description?: string
  parameters: AppParameterSpec[]
}

/** One parameter an App declares — the field an add fills in and `app_get` shows the value of. */
export interface AppParameterSpec {
  id: string
  label: string
  required?: boolean
  description?: string
}

/** The fields an App takes, as the catalog and `app_get` both report them. */
function parameterSpecs(entry: AppEntry | undefined): AppParameterSpec[] {
  return (entry?.parameters ?? []).map((spec) => ({
    id: spec.id,
    label: spec.label,
    required: spec.required,
    description: spec.description,
  }))
}

/** Every App any extension provides — what an `app_add` can instantiate. */
export async function listAppCatalog(): Promise<AppCatalogEntry[]> {
  const provided = await providedApps()
  return provided.map(({ value }) => ({
    type: value.type,
    title: value.title,
    description: value.description,
    parameters: parameterSpecs(value),
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
  type: string,
  name: string,
  input?: Record<string, string>,
): Promise<SpaceAppRow> {
  const r = await registry()
  const space = r.getBySlug(spaceSlug)
  if (!space) {
    throw new Error(`Unknown space: ${spaceSlug}`)
  }
  const provided = await providedApps()
  const entry = provided.find((p) => p.value.type === type)?.value
  if (!entry) {
    throw new Error(`No extension provides the App type ${type}`)
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
    .values({ spaceId: space.id, type, name: trimmedName, slug, params: JSON.stringify(params) })
    .returning()
  try {
    await handleInstanceAdded(row)
  } catch (error) {
    await db.delete(spaceApp).where(eq(spaceApp.id, row.id))
    await fs.rm(instanceDataDir(row.type, row.id), { recursive: true, force: true })
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
 * Rename one instance: the name AND the address it is reachable at.
 *
 * The slug used to be fixed at creation, so everything written down elsewhere
 * kept resolving. That was reversed deliberately, with the
 * consequence stated — previously saved or shared links stop resolving — so
 * it is not to be softened into an alias or a redirect by whoever reads this
 * next. A slug that no longer resolves does exactly what a nonexistent uuid
 * does: 404, the address left as typed, nothing substituted.
 *
 * A taken slug is REFUSED and nothing changes, not even the display name.
 * Handing back a suffixed slug would leave the instance answering to an
 * address nobody named, which is the same reason the add path refuses.
 *
 * Apps that mirror the name and slug into data they own (the Graph App's
 * graph row) follow through onRenamed, and a hook that refuses rolls the row
 * back — the instance does not keep an address its App would not take.
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
  const slug = instanceSlugFor(trimmedName)
  if (slug !== row.slug) {
    const siblings = await db.query.spaceApp.findMany({ where: eq(spaceApp.spaceId, row.spaceId) })
    if (siblings.some((sibling) => sibling.id !== row.id && sibling.slug === slug)) {
      const space = (await registry()).getById(row.spaceId)
      throw new AppSlugTakenError(`${space?.slug ?? ''}.${slug}`)
    }
  }
  const [updated] = await db
    .update(spaceApp)
    .set({ name: trimmedName, slug, updatedAt: new Date() })
    .where(eq(spaceApp.id, row.id))
    .returning()
  const hooks = await hooksFor(row.type)
  try {
    await hooks?.onRenamed?.(await instanceContext(updated), row.name)
  } catch (error) {
    // The App refused the new address, so the instance does not keep it. Same
    // compensating shape as the add and transfer paths: an instance whose slug
    // moved while the graph it owns stayed put would be one instance answering
    // to two addresses, which is worse than the rename not happening.
    await db.update(spaceApp).set({ name: row.name, slug: row.slug }).where(eq(spaceApp.id, row.id))
    throw error
  }
  const loaded = loadedInstances().get(row.id)
  if (loaded) {
    loaded.ctx = await instanceContext(updated)
  }
  return updated
}

/**
 * Bind one instance to another App, keeping everything the instance has: its
 * id, name, address, parameters and data. This is how an instance whose App
 * is no longer provided (its extension is gone or was renamed) is pointed at
 * one that is.
 *
 * The data directory is keyed by the providing extension, so it moves with the
 * instance: directory first, then the row, and a failed row write moves the
 * directory back so the two never disagree. A directory already present at
 * the destination is refused rather than merged into.
 *
 * The new App's onLoad runs last, as at boot. It is not onAdded: the instance
 * is not new, and its data is still there. A load that throws leaves the
 * instance retyped, as a failed load at boot leaves it stored, and comes back
 * as `loadError` for the caller to report. Anything that throws happened
 * before the row changed.
 */
export async function retypeSpaceAppImpl(
  instanceId: string,
  type: string,
): Promise<{ row: SpaceAppRow; loadError?: string }> {
  const row = await db.query.spaceApp.findFirst({ where: eq(spaceApp.id, instanceId) })
  if (!row) {
    throw new Error(`Unknown app instance: ${instanceId}`)
  }
  if (!(await isProvided(type))) {
    throw new Error(`No extension provides the App type ${type}`)
  }
  await unloadInstance(row.id)
  const fromDir = instanceDataDir(row.type, row.id)
  const toDir = instanceDataDir(type, row.id)
  const moved = fromDir !== toDir && (await moveDataDir(fromDir, toDir))
  let updated: SpaceAppRow
  try {
    ;[updated] = await db
      .update(spaceApp)
      .set({ type, updatedAt: new Date() })
      .where(eq(spaceApp.id, row.id))
      .returning()
  } catch (error) {
    if (moved) {
      await fs.rename(toDir, fromDir)
    }
    throw error
  }
  try {
    await loadInstance(updated)
  } catch (error) {
    console.error(`[apps] load failed for ${type} (${updated.id})`, error)
    return { row: updated, loadError: error instanceof Error ? error.message : String(error) }
  }
  return { row: updated }
}

/** Fire onUnload for one instance if it is loaded. Its App may be gone, so a hook that cannot run is logged. */
async function unloadInstance(instanceId: string): Promise<void> {
  const loaded = loadedInstances().get(instanceId)
  if (!loaded) {
    return
  }
  try {
    const hooks = await hooksFor(loaded.type)
    await hooks?.onUnload?.(loaded.ctx)
  } catch (error) {
    console.error(`[apps] unload failed for ${loaded.type} (${instanceId})`, error)
  }
  loadedInstances().delete(instanceId)
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/** Move a data directory; false when there was none to move. */
async function moveDataDir(fromDir: string, toDir: string): Promise<boolean> {
  if (!(await pathExists(fromDir))) {
    return false
  }
  if (await pathExists(toDir)) {
    throw new Error(`A data directory already exists at ${toDir}`)
  }
  await fs.mkdir(path.dirname(toDir), { recursive: true })
  await fs.rename(fromDir, toDir)
  return true
}

/** The manifest entry a row's App was declared in, or undefined when its extension is gone. */
function appEntryFor(provided: Provided<AppEntry>[], row: SpaceAppRow): AppEntry | undefined {
  return provided.find((p) => p.value.type === row.type)?.value
}

/**
 * One app as the MCP surface reports it to agents. Compact by design — this is
 * what `app_list` prints into an agent's context, so it carries what a caller
 * needs to CHOOSE a target and nothing else. The parameter values an app was
 * configured with answer a different question, and `app_get` answers it.
 *
 * Listed under its PUBLIC ADDRESS, `<space>.<slug>` — so the address and the
 * space are the key rather than fields, and the uuid appears nowhere. The uuid
 * still resolves everywhere the address does and always will, but an agent
 * spends what the listings give it, so emitting it here is what kept it in
 * circulation. Acceptance is not vocabulary; emission is.
 */
export interface SpaceAppInfo {
  /** The App this is an instance of: its qualified type, `<owner>.<extension>.<type>`. */
  type: string
  /** The instance's own name — what the user called it, not the App's title. */
  name: string
  /**
   * The context sources this app exposes RIGHT NOW, as the ids a
   * `<address>/<handle-id>` target takes, with dynamic declarations already
   * expanded. Absent when the App declares none.
   */
  handles?: string[]
}

/**
 * What `app_list` hands back: the apps, and the action ids each TYPE exposes.
 *
 * Actions hang off the type rather than off each app because that is what
 * declares them — one manifest entry, however many apps are added from it.
 * Repeating them per app is what made this listing too large to read: a space
 * holding twelve apps of one type printed twelve identical copies of its
 * action list. What each action DOES and what it takes is a second question,
 * answered by `app_actions` for the ones a caller has settled on.
 */
export interface SpaceAppListing {
  apps: Record<string, SpaceAppInfo>
  actions: Record<string, string[]>
}

/** Every added app, optionally narrowed to one space slug. */
export async function listSpaceApps(spaceSlug?: string): Promise<SpaceAppListing> {
  const rows = await db.query.spaceApp.findMany({ orderBy: asc(spaceApp.createdAt) })
  const r = await registry()
  const slugById = new Map(r.list().map((s) => [s.id, s.slug]))
  const provided = await providedApps()
  const apps: Record<string, SpaceAppInfo> = {}
  const actions: Record<string, string[]> = {}
  for (const row of rows) {
    const space = slugById.get(row.spaceId) ?? ''
    if (spaceSlug && space !== spaceSlug) {
      continue
    }
    const entry = appEntryFor(provided, row)
    const info: SpaceAppInfo = { type: row.type, name: row.name }
    const handles = await liveHandles(row, entry)
    if (handles.length > 0) {
      info.handles = handles.map(({ handleId }) => handleId)
    }
    apps[`${space}.${row.slug}`] = info
    actions[row.type] = (entry?.actions ?? []).map((action) => action.id)
  }
  return { apps, actions }
}

/**
 * One app in full — what `app_list` leaves out because choosing a target does
 * not need it, and configuring one cannot do without it: the values this app
 * was added with, and the fields those values fill.
 */
export interface SpaceAppDetail extends SpaceAppInfo {
  address: string
  /** The extension the type names — whether or not it is installed. */
  extensionId: string | null
  /** False while the extension providing the App is not installed; the instance keeps its data meanwhile. */
  provided: boolean
  title: string
  description?: string
  params: Record<string, string>
  parameters: AppParameterSpec[]
}

/** The row one app reference names, or a refusal that says how apps are addressed. */
async function requireAppRow(ref: string): Promise<SpaceAppRow> {
  const row = await resolveAppAddress(ref)
  if (!row) {
    throw new Error(`Unknown app: ${ref}. An app is addressed <space>.<app-slug> — run app_list to see them.`)
  }
  return row
}

/** One app's configuration, by address or identity. */
export async function appDetail(ref: string): Promise<SpaceAppDetail> {
  const row = await requireAppRow(ref)
  const address = await appAddressOf(row)
  if (!address) {
    throw new Error(`App "${ref}" belongs to no registered space.`)
  }
  const entry = appEntryFor(await providedApps(), row)
  const detail: SpaceAppDetail = {
    address,
    type: row.type,
    name: row.name,
    extensionId: extensionIdOfType(row.type),
    provided: entry !== undefined,
    title: entry?.title ?? row.type,
    description: entry?.description,
    params: JSON.parse(row.params) as Record<string, string>,
    parameters: parameterSpecs(entry),
  }
  const handles = await liveHandles(row, entry)
  if (handles.length > 0) {
    detail.handles = handles.map(({ handleId }) => handleId)
  }
  return detail
}

/**
 * The App a qualified type names. Two extensions may each declare an App
 * called `git`; qualified, those are two types, so a type names one App.
 */
function appOfType(provided: Provided<AppEntry>[], type: string): AppEntry {
  const match = provided.find((p) => p.value.type === type)
  if (!match) {
    throw new Error(
      `No App type "${type}" — a type is <owner>.<extension>.<type>; run app_list to see the types in use.`,
    )
  }
  return match.value
}

/**
 * What an app's actions DO and what they take — the half `app_list` leaves
 * behind, loaded for the actions a caller has settled on.
 *
 * `app` is an app's address or its type, because both are in hand at the point
 * this is needed: the listing gives the type, and the caller already knows the
 * address it means to call. An app whose extension no longer provides its App
 * is a refusal rather than an empty list — no actions declared and no manifest
 * to declare them are different answers, and only one of them is about this
 * app.
 */
export async function listAppActions(app: string, ids?: string[]): Promise<AppActionMeta[]> {
  const provided = await providedApps()
  let entry: AppEntry
  // A qualified type is dotted too, but with two dots where an address has one.
  if (isAppAddress(app) && !parseType(app)) {
    const row = await requireAppRow(app)
    const found = appEntryFor(provided, row)
    if (!found) {
      throw new Error(missingProviderMessage(row))
    }
    entry = found
  } else {
    entry = appOfType(provided, app)
  }
  const actions = entry.actions ?? []
  if (!ids) {
    return actions
  }
  const missing = ids.filter((id) => !actions.some((action) => action.id === id))
  if (missing.length > 0) {
    throw new Error(`"${app}" has no action ${missing.map((id) => `"${id}"`).join(', ')}.`)
  }
  return actions.filter((action) => ids.includes(action.id))
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
  /** The App's qualified type. */
  type: string
  /** The App's title — what a picker shows in the node-name position. */
  title: string
  /** The live id; for a dynamic declaration, an expanded runtime id. */
  handleId: string
  /** The manifest id — the prefix form for a dynamic declaration. */
  declaredId: string
  /** The qualified handle type. */
  handleType: string
  label?: string
  dynamic: boolean
}

/**
 * What one app's handles ARE right now: its App's declarations, with dynamic
 * ones expanded through the extension's `listHandles` hook. Uncached for the
 * same reason node handle discovery is — expansion asks the App what exists at
 * this moment. An instance that cannot be asked is logged and contributes
 * nothing rather than failing the listing it is part of.
 *
 * The one definition of "live", shared by the two listings that need it: the
 * ids `app_list` prints, and the descriptions `listAppHandles` builds.
 */
async function liveHandles(
  row: SpaceAppRow,
  entry: AppEntry | undefined,
  handleType?: string,
): Promise<Array<{ handle: AppHandle; handleId: string }>> {
  const declared = (entry?.handles ?? []).filter(
    (handle) => handleType === undefined || handle.handleType === handleType,
  )
  if (declared.length === 0) {
    return []
  }
  let liveIds: string[] = []
  if (declared.some((handle) => handle.dynamic)) {
    try {
      const hooks = await hooksFor(row.type)
      liveIds = (await hooks?.listHandles?.(await instanceContext(row))) ?? []
    } catch (error) {
      console.error(`[apps] listHandles failed for ${row.type} (${row.id})`, error)
      return []
    }
  }
  return declared.flatMap((handle) =>
    handle.dynamic
      ? liveIds.filter((id) => id.startsWith(handle.id)).map((handleId) => ({ handle, handleId }))
      : [{ handle, handleId: handle.id }],
  )
}

/** Every live handle every App instance exposes, described for a handle picker. */
export async function listAppHandles(handleType?: string): Promise<AppHandleInfo[]> {
  const rows = await db.query.spaceApp.findMany({ orderBy: asc(spaceApp.createdAt) })
  if (rows.length === 0) {
    return []
  }
  const r = await registry()
  const slugById = new Map(r.list().map((s) => [s.id, s.slug]))
  const provided = await providedApps()
  const results: AppHandleInfo[] = []
  for (const row of rows) {
    const entry = appEntryFor(provided, row)
    const base = {
      instanceId: row.id,
      spaceSlug: slugById.get(row.spaceId) ?? '',
      type: row.type,
      title: entry?.title ?? row.type,
    }
    for (const { handle, handleId } of await liveHandles(row, entry, handleType)) {
      results.push({ ...base, ...handleFields(handle, handleId) })
    }
  }
  return results
}

function handleFields(handle: AppHandle, liveId: string) {
  return {
    handleId: liveId,
    declaredId: handle.id,
    handleType: handle.handleType,
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
  const hooks = await hooksFor(row.type)
  if (!hooks?.getHandleContext) {
    return undefined
  }
  const ctx = await instanceContext(row)
  const value = await hooks.getHandleContext(ctx, handleId)
  return value ? { value, spaceSlug: ctx.spaceSlug } : undefined
}

/**
 * What `app_call` has to know before it runs an action: the app's address, and
 * the manifest's declaration of the action — which says how a caller waits for
 * it. The address rather than the caller's reference, because a task started
 * from this is listed under it, and a uuid echoed back is the one thing an
 * emitter must not hand out. Undefined when the reference names no app; the
 * call then fails the way it always has.
 */
export async function appActionDeclaration(
  ref: string,
  actionId: string,
): Promise<{ address: string; action?: AppActionMeta } | undefined> {
  const row = await resolveAppAddress(ref)
  if (!row) {
    return undefined
  }
  const entry = appEntryFor(await providedApps(), row)
  return {
    address: (await appAddressOf(row)) ?? ref,
    action: entry?.actions?.find((action) => action.id === actionId),
  }
}

/**
 * Dispatch one App action against one instance — the code path of the
 * `app_call` MCP tool and of an App's own UI (`callAppActionFromUi`). Takes
 * either spelling of an app reference; see `resolveAppAddress`. `caller` is who
 * the host established is asking — each entry point binds it from its own
 * authentication, never from the request's data. `signal` is handed to the
 * action when it runs as a background task, so one that is cancelled or times
 * out can stop.
 */
export async function callAppAction(
  ref: string,
  actionId: string,
  params: Record<string, unknown>,
  caller?: AppActionCaller,
  signal?: AbortSignal,
): Promise<unknown> {
  const row = await requireAppRow(ref)
  const extensionId = extensionIdOfType(row.type)
  const hooks = await hooksFor(row.type)
  if (!hooks || !extensionId) {
    throw new Error(missingProviderMessage(row))
  }
  const handler = hooks.actions?.[actionId]
  if (!handler) {
    throw new Error(`App ${row.type} has no action "${actionId}"`)
  }
  // Lazy: the extension host reaches back into this module (app handles), and
  // the action path is the only one here that needs the host at all.
  const { groupChatsForCaller } = await import('@/app/_authed/(extension-runtime)/_server/host')
  const groupChats = groupChatsForCaller(extensionId, caller)
  const ctx = {
    ...(await instanceContext(row)),
    ...(caller && 'agent' in caller ? { callerAgent: caller.agent } : {}),
    ...(caller && 'person' in caller ? { callerPerson: caller.person } : {}),
    signal,
    groupChats: groupChats.api,
  }
  try {
    return await handler(ctx, params)
  } finally {
    groupChats.end()
  }
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
      console.error(`[apps] load failed for ${row.type} (${row.id})`, error)
    }
  }
}
