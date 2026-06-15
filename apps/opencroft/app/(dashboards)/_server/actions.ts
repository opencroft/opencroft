import type { DashboardMeta } from '@opencroft/dashboards'
import { createServerFn } from '@tanstack/react-start'

import { getProvided } from '@/app/(extension-runtime)/_server/provides'

interface DashboardEntry {
  slug: string
  title: string
  description?: string
}

// Glue: specializes the runtime's generic provider reader to the `dashboards`
// point, so the server knows every dashboard before any client bundle loads —
// the list and sidebar render server-side with no flash.
export const listDashboards = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<DashboardMeta[]> => {
    const provided = await getProvided<DashboardEntry>('dashboards')
    return provided.map(({ extensionId, value }) => ({ ...value, extensionId }))
  },
)
