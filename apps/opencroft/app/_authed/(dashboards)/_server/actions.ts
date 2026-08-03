import { getSessionUser } from '@opencroft/auth/server'
import type { DashboardMeta } from '@opencroft/dashboards'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import { getProvided } from '@/app/_authed/(extension-runtime)/_server/provides'

interface DashboardEntry {
  slug: string
  title: string
  description?: string
}

// Same reasoning as (space)/_server/actions.ts's requireSession
// (RPC gating): the page gate guards navigation, not this RPC
// endpoint directly. Safe to check inline here, unlike listSpaces/
// loadSpaceGraph — every live caller (checked, not assumed) is a browser
// route loader downstream of the _authed beforeLoad gate; nothing calls this
// in-process the way (mcp)/_server/tools.ts calls the space actions.
async function requireSession(): Promise<void> {
  const user = await getSessionUser(getRequest())
  if (!user) {
    throw new Error('Not signed in')
  }
}

// Glue: specializes the runtime's generic provider reader to the `dashboards`
// point, so the server knows every dashboard before any client bundle loads —
// the list and sidebar render server-side with no flash.
export const listDashboards = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<DashboardMeta[]> => {
    await requireSession()
    const provided = await getProvided<DashboardEntry>('dashboards')
    return provided.map(({ extensionId, value }) => ({ ...value, extensionId }))
  },
)
