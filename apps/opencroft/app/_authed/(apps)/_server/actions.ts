import { getSessionUser } from '@opencroft/auth/server'
import { db, spaceApp } from '@opencroft/db'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, asc, eq } from 'drizzle-orm'

import { providedApps } from '@/app/_authed/(apps)/_server/host-apps'
import {
  addSpaceAppImpl,
  appUpdatesInPlace,
  callAppAction,
  handleInstanceUpdated,
  removeSpaceAppImpl,
  renameSpaceAppImpl,
  transferSpaceAppImpl,
} from '@/app/_authed/(apps)/_server/runtime'
import type { AppMeta, SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { registry } from '@/app/_authed/(space)/_server/actions-impl'

// The page gate guards navigation, not these RPC endpoints, which are
// callable in their own right. Checked inline because every live caller is a
// browser route loader or component downstream of the _authed beforeLoad
// gate; nothing calls these in-process. Opening an App (the page loader's
// `listSpaceApps`) and calling its actions from its UI pass this same gate.
async function requireSession() {
  const user = await getSessionUser(getRequest())
  if (!user) {
    throw new Error('Not signed in')
  }
  return user
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
  const provided = await providedApps()
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
    name: row.name,
    slug: row.slug,
    params: JSON.parse(row.params) as Record<string, string>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Every App any extension provides, from the manifests — available to add to a space. */
export const listApps = createServerFn({ strict: { output: false } }).handler(async (): Promise<AppMeta[]> => {
  await requireSession()
  const provided = await providedApps()
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
    (data: {
      spaceSlug: string
      extensionId: string
      appSlug: string
      name: string
      params?: Record<string, string>
    }) => data,
  )
  .handler(async ({ data }): Promise<SpaceAppInstance> => {
    await requireSession()
    const row = await addSpaceAppImpl(data.spaceSlug, data.extensionId, data.appSlug, data.name, data.params)
    return toInstance(row)
  })

/**
 * Rename one instance in place: the name and the address, since the slug now
 * follows the label. Refused if the new slug is taken in the
 * space, changing nothing. Never recreates, whatever the App's update mode;
 * an App mirroring the name and slug into its own data follows through
 * onRenamed.
 */
export const renameSpaceApp = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { spaceSlug: string; instanceId: string; name: string }) => data)
  .handler(async ({ data }): Promise<SpaceAppInstance> => {
    await requireSession()
    const spaceId = await resolveSpaceId(data.spaceSlug)
    const row = await db.query.spaceApp.findFirst({
      where: and(eq(spaceApp.id, data.instanceId), eq(spaceApp.spaceId, spaceId)),
    })
    if (!row) {
      throw new Error(`Unknown app instance: ${data.instanceId}`)
    }
    return toInstance(await renameSpaceAppImpl(data.instanceId, data.name))
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
 * Run one of an App instance's actions for its own UI — `callAppAction` in
 * `@opencroft/client`. The same dispatch `app_call` uses, with the signed-in
 * person as the caller: taken from the session here, never from `data`, so a
 * client cannot name who it is.
 */
export const callAppActionFromUi = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { instanceId: string; action: string; params?: Record<string, unknown> }) => data)
  .handler(async ({ data }): Promise<unknown> => {
    const user = await requireSession()
    const person = { id: user.id, name: user.name, avatarUrl: user.image ?? null }
    return callAppAction(String(data.instanceId), String(data.action), data.params ?? {}, { person })
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
    return removeSpaceAppImpl(row.id)
  })
