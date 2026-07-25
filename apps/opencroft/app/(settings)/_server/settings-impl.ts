import type { Setting } from '@/app/(settings)/_server/setting'
import * as db from '@/server/data'

// Plain (non-server-fn) implementations of getSetting/setSetting, for callers that
// don't run inside a TanStack Start request lifecycle — e.g. an extension's Nitro
// HTTP route handler, which never establishes the request-scoped AsyncLocalStorage
// context createServerFn depends on (unlike an extension action, invoked through a
// real createFileRoute). Kept in their own module, never imported by client-side
// code, so actions.ts's createServerFn exports can delegate to them while keeping
// their exact behavior. Deliberately not placed alongside the createServerFn exports
// in actions.ts — a plain export living in that file would keep its top-level imports
// "live" for the client bundle too, since TanStack's client-build code splitting only
// elides a handler body, not a shared file's own imports.
export async function getSettingImpl(id: string): Promise<Setting<Record<string, unknown>> | null> {
  const row = await db.getSetting(id)
  if (!row) {
    return null
  }
  return { ...row, data: JSON.parse(row.data) as Record<string, unknown> }
}

export async function setSettingImpl(data: {
  id: string
  data: Record<string, unknown>
}): Promise<Setting<Record<string, unknown>>> {
  const { id } = data
  const row = await db.upsertSetting(id, JSON.stringify(data.data))
  return { ...row, data: data.data }
}
