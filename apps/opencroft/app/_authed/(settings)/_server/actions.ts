import { AdminActionError, requireAdminUser } from '@opencroft/auth/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import type { Setting } from '@/app/_authed/(settings)/_server/setting'
import { getSettingImpl, setSettingImpl } from '@/app/_authed/(settings)/_server/settings-impl'
import * as db from '@/server/data'

// THESE FOUR ARE THE GENERIC `setting` TABLE'S RPC SURFACE, AND EACH GATES
// ITSELF. A createServerFn is a callable endpoint in its own right, reachable
// by a direct request that never renders the page it lives behind -- so the
// `_authed` route guard is UX, not a security boundary (see app/_authed.tsx),
// and the check has to sit in the handler. Without it these accepted a
// caller-supplied id from anyone, signed in or not, over the whole table: MCP
// server list, agent sessions, skills, extension storage, file-manager
// connections.
//
// Admin rather than merely signed-in, because what this table's RPC surface
// exposes is instance configuration, not a person's own data. The per-user and
// system reads of the same rows do NOT come through here -- they call the raw
// `@/server/data` layer directly and run their own appropriate check (a group
// chat member's thread layout, the agent runtime's stores),
// so gating the endpoint does not touch them.

// `requireAdminUser` RETURNS the admin or null -- it does not throw -- so the
// result has to be acted on. A bare `await requireAdminUser(...)` with the
// value dropped type-checks and gates nothing. This mirrors the guard every
// admin-only function in packages/auth/src/server.ts already uses.
async function requireAdmin(): Promise<void> {
  if (!(await requireAdminUser(getRequest()))) {
    throw new AdminActionError('forbidden', 'Only an administrator can access settings')
  }
}

export const getSetting = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }): Promise<Setting<Record<string, unknown>> | null> => {
    await requireAdmin()
    return getSettingImpl(id)
  })

export const setSetting = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { id: string; data: Record<string, unknown> }) => data)
  .handler(async ({ data }): Promise<Setting<Record<string, unknown>>> => {
    await requireAdmin()
    return setSettingImpl(data)
  })

export const updateSetting = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { id: string; data: Partial<Record<string, unknown>> }) => data)
  .handler(async ({ data }): Promise<Setting<Record<string, unknown>> | null> => {
    await requireAdmin()
    const { id } = data
    const existing = await db.getSetting(id)
    if (!existing) {
      return null
    }
    const merged = { ...JSON.parse(existing.data), ...data.data } as Record<string, unknown>
    const row = await db.upsertSetting(id, JSON.stringify(merged))
    return { ...row, data: merged }
  })

export const deleteSetting = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }): Promise<boolean> => {
    await requireAdmin()
    return db.deleteSetting(id)
  })
