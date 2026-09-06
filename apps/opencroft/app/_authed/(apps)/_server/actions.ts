import { promises as fs } from 'node:fs'

import { getSessionUser } from '@opencroft/auth/server'
import type { AppEntry } from '@opencroft/core'
import { db, spaceApp } from '@opencroft/db'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, asc, eq } from 'drizzle-orm'

import { appInstanceDataDir } from '@/app/_authed/(apps)/_server/instance-paths'
import {
  appUpdatesInPlace,
  handleInstanceAdded,
  handleInstanceBeforeRemoved,
  handleInstanceRemoved,
  handleInstanceUpdated,
  transferAllSpaceAppsImpl,
  transferSpaceAppImpl,
} from '@/app/_authed/(apps)/_server/runtime'
import type { AppMeta, SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { getProvided } from '@/app/_authed/(extension-runtime)/_server/provides'
import { registry } from '@/app/_authed/(space)/_server/actions-impl'

// Same reasoning as (dashboards)/_server/actions.ts's requireSession: the
// page gate guards navigation, not these RPC endpoints. Checked inline
// because every live caller is a browser route loader or component
// downstream of the _authed beforeLoad gate; nothing calls these in-process.
async function requireSession(): Promise<void> {
  const user = await getSessionUser(getRequest())
  if (!user) {
    throw new Error('Not signed in')
  }
}

async function resolveSpaceId(spaceSlug: string): Promise<string> {
  const r = await registry()
  const space = r.getBySlug(spaceSlug)
  if (!space) {
    throw new Error(`Unknown space: ${spaceSlug}`)
  }
  return space.id
}

async function findApp(extensionId: string, appSlug: string): Promise<AppMeta | undefined> {
  const provided = await getProvided<AppEntry>('apps')
  const match = provided.find((p) => p.extensionId === extensionId && p.value.slug === appSlug)
  return match ? { ...match.value, extensionId: match.extensionId } : undefined
}

/**
 * The parameter values an instance keeps: only declared parameters, trimmed,
 * empty values dropped, declared `required` parameters present.
 */
function collectParams(app: AppMeta, input?: Record<string, string>): Record<string, string> {
  const params: Record<string, string> = {}
  for (const spec of app.parameters ?? []) {
    const value = input?.[spec.id]?.trim() ?? ''
    if (spec.required && !value) {
      throw new Error(`Missing required parameter: ${spec.label}`)
    }
    if (value) {
      params[spec.id] = value
    }
  }
  return params
}

function toInstance(row: typeof spaceApp.$inferSelect): SpaceAppInstance {
  return {
    id: row.id,
    extensionId: row.extensionId,
    appSlug: row.appSlug,
    params: JSON.parse(row.params) as Record<string, string>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Every App any extension provides, from the manifests — available to add to a space. */
export const listApps = createServerFn({ strict: { output: false } }).handler(async (): Promise<AppMeta[]> => {
  await requireSession()
  const provided = await getProvided<AppEntry>('apps')
  return Promise.all(
    provided.map(async ({ extensionId, value }) => ({
      ...value,
      extensionId,
      updatesInPlace: await appUpdatesInPlace(extensionId, value.slug),
    })),
  )
})

/** The Apps added to one space, with the entered parameter values. */
export const listSpaceApps = createServerFn({ strict: { output: false } })
  .inputValidator((spaceSlug: string) => spaceSlug)
  .handler(async ({ data: spaceSlug }): Promise<SpaceAppInstance[]> => {
    await requireSession()
    const spaceId = await resolveSpaceId(spaceSlug)
    const rows = await db.query.spaceApp.findMany({
      where: eq(spaceApp.spaceId, spaceId),
      orderBy: asc(spaceApp.createdAt),
    })
    return rows.map(toInstance)
  })

/**
 * Add an instance of an App to a space. The same App can be added many times
 * with different parameter values — each add is a new instance. Parameter
 * values are kept only for parameters the App declares, and declared
 * `required` parameters must be non-empty.
 *
 * The instance is only kept if the extension accepts it: a throwing
 * onAdded/onLoad hook (e.g. a clone of an unreachable repository) rolls the
 * row and its data directory back and surfaces the error to the caller.
 */
export const addSpaceApp = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator(
    (data: { spaceSlug: string; extensionId: string; appSlug: string; params?: Record<string, string> }) => data,
  )
  .handler(async ({ data }): Promise<SpaceAppInstance> => {
    await requireSession()
    const spaceId = await resolveSpaceId(data.spaceSlug)
    const app = await findApp(data.extensionId, data.appSlug)
    if (!app) {
      throw new Error(`No extension provides app: ${data.extensionId}/${data.appSlug}`)
    }
    const params = collectParams(app, data.params)
    const [row] = await db
      .insert(spaceApp)
      .values({ spaceId, extensionId: data.extensionId, appSlug: data.appSlug, params: JSON.stringify(params) })
      .returning()
    try {
      await handleInstanceAdded(row)
    } catch (error) {
      await db.delete(spaceApp).where(eq(spaceApp.id, row.id))
      await fs.rm(appInstanceDataDir(row.extensionId, row.id), { recursive: true, force: true })
      throw error
    }
    return toInstance(row)
  })

/**
 * Change one instance's parameters. An App with an onUpdated hook reacts in
 * place and keeps its data; any other instance is recreated — unloaded, its
 * data directory deleted, then initialized again from the new values (see
 * handleInstanceUpdated). The UI warns before calling this.
 */
export const updateSpaceApp = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { spaceSlug: string; instanceId: string; params?: Record<string, string> }) => data)
  .handler(async ({ data }): Promise<SpaceAppInstance> => {
    await requireSession()
    const spaceId = await resolveSpaceId(data.spaceSlug)
    const row = await db.query.spaceApp.findFirst({
      where: and(eq(spaceApp.id, data.instanceId), eq(spaceApp.spaceId, spaceId)),
    })
    if (!row) {
      throw new Error(`Unknown app instance: ${data.instanceId}`)
    }
    const app = await findApp(row.extensionId, row.appSlug)
    if (!app) {
      throw new Error(`No extension provides app: ${row.extensionId}/${row.appSlug}`)
    }
    const params = collectParams(app, data.params)
    const updated = await handleInstanceUpdated(row, JSON.stringify(params))
    return toInstance(updated)
  })

/**
 * Move one App instance to another space, with whatever space-scoped data
 * its App owns (a Graph instance moves its whole graph). A transfer the
 * App's hook refuses rolls back whole and surfaces the error.
 */
export const transferSpaceApp = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { spaceSlug: string; instanceId: string; targetSpaceSlug: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    await requireSession()
    const spaceId = await resolveSpaceId(data.spaceSlug)
    const row = await db.query.spaceApp.findFirst({
      where: and(eq(spaceApp.id, data.instanceId), eq(spaceApp.spaceId, spaceId)),
    })
    if (!row) {
      throw new Error(`Unknown app instance: ${data.instanceId}`)
    }
    await transferSpaceAppImpl(data.instanceId, data.targetSpaceSlug)
  })

/**
 * Move EVERY App instance of a space to another space — the "transfer space"
 * action in the space's settings. Returns how many instances moved. The
 * emptied space keeps a fresh default graph and can then be deleted.
 */
export const transferAllSpaceApps = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { spaceSlug: string; targetSpaceSlug: string }) => data)
  .handler(async ({ data }): Promise<number> => {
    await requireSession()
    return transferAllSpaceAppsImpl(data.spaceSlug, data.targetSpaceSlug)
  })

/**
 * Remove one App instance from a space: unload it, fire onRemoved, delete its
 * data directory, drop the row. Returns whether anything was removed.
 */
export const removeSpaceApp = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { spaceSlug: string; instanceId: string }) => data)
  .handler(async ({ data }): Promise<boolean> => {
    await requireSession()
    const spaceId = await resolveSpaceId(data.spaceSlug)
    const row = await db.query.spaceApp.findFirst({
      where: and(eq(spaceApp.id, data.instanceId), eq(spaceApp.spaceId, spaceId)),
    })
    if (!row) {
      return false
    }
    // The App's veto, before anything is touched: a throw surfaces to the
    // caller and the instance stays whole (e.g. the Graph App refusing to
    // remove the space's default graph).
    await handleInstanceBeforeRemoved(row)
    await handleInstanceRemoved(row)
    await db.delete(spaceApp).where(eq(spaceApp.id, row.id))
    return true
  })
