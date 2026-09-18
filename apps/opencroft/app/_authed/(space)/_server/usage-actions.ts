import { createServerFn } from '@tanstack/react-start'
import type { SpaceUsageSeries, UsageGrouping, UsagePeriod } from 'ui/admin/space-usage'

import { deleteChatUsage, queryChatUsage } from '@/app/_authed/(agent)/_server/chat-usage-store'
import { requireSessionServerFn } from '@/app/_server/require-session'

export interface SpaceUsageQuery {
  grouping: UsageGrouping
  period: UsagePeriod
}

// The space settings page's Usage section. `slug` isn't read yet: v1
// aggregates instance-wide rather than per-space (see the comment on
// queryChatUsage), so threading it through here now would just be an unused
// parameter until the chat→space resolution above it exists.
export const getSpaceUsage = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((query: SpaceUsageQuery) => query)
  .handler(async ({ data }): Promise<SpaceUsageSeries[]> => {
    await requireSessionServerFn()
    return queryChatUsage(data.grouping, data.period)
  })

// The Usage section's reset: every turn recorded in the period goes. Same
// v1 scope as the read above — instance-wide — so the button on one space's
// page clears what every space's page shows.
export const resetSpaceUsage = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { period: UsagePeriod }) => data)
  .handler(async ({ data }): Promise<{ removed: number }> => {
    await requireSessionServerFn()
    return { removed: await deleteChatUsage(data.period) }
  })
