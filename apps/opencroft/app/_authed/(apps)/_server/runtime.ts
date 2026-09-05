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

import { appInstanceDataDir } from '@/app/_authed/(apps)/_server/instance-paths'
import { getExtensionModule } from '@/app/_authed/(extension-runtime)/_server/loader'
import { getProvided } from '@/app/_authed/(extension-runtime)/_server/provides'
import { registry } from '@/app/_authed/(space)/_server/actions-impl'
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

async function hooksFor(extensionId: string, appSlug: string): Promise<AppServerHooks | undefined> {
  const mod = await getExtensionModule(extensionId)
  return mod.apps?.[appSlug]
}

async function instanceContext(row: SpaceAppRow): Promise<AppInstanceContext> {
  const r = await registry()
  const space = r.list().find((s) => s.id === row.spaceId)
  return {
    instanceId: row.id,
    spaceSlug: space?.slug ?? '',
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
 * The remove flow: unload if loaded, fire onRemoved, delete the data
 * directory. Hook failures are logged, not rethrown — the user asked for the
 * instance to be gone, and a hook that cannot say goodbye does not get to
 * keep it.
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
 * One instance as the MCP surface reports it to agents: identity, the space
 * it lives in, its parameter values, and the actions its App declares in the
 * manifest. Compact by design — this is what `list_apps` prints into an
 * agent's context.
 */
export interface SpaceAppInfo {
  instanceId: string
  extensionId: string
  appSlug: string
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
      instanceId: row.id,
      extensionId: row.extensionId,
      appSlug: row.appSlug,
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
 * `HandleInfo`, addressed as `<instanceId>/<handleId>`. Only sources exist:
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
 * The context value behind `<instanceId>/<handleId>`, via the extension's
 * `getHandleContext` hook. Undefined when the id is no App instance, the App
 * declares no handles, or the hook does not recognize the handle — callers
 * fall through to (or from) node resolution on it.
 */
export async function resolveAppHandleContext(
  instanceId: string,
  handleId: string,
): Promise<{ value: Record<string, unknown>; spaceSlug: string } | undefined> {
  const row = await db.query.spaceApp.findFirst({ where: eq(spaceApp.id, instanceId) })
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

/** Dispatch one App action against one instance — the `app_call` MCP tool's code path. */
export async function callAppAction(
  instanceId: string,
  actionId: string,
  params: Record<string, unknown>,
  callerAgent?: string,
): Promise<unknown> {
  const row = await db.query.spaceApp.findFirst({ where: eq(spaceApp.id, instanceId) })
  if (!row) {
    throw new Error(`Unknown app instance: ${instanceId}`)
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
  const rows = await db.query.spaceApp.findMany({ orderBy: asc(spaceApp.createdAt) })
  for (const row of rows) {
    try {
      await loadInstance(row)
    } catch (error) {
      console.error(`[apps] load failed for ${row.extensionId}/${row.appSlug} (${row.id})`, error)
    }
  }
}
