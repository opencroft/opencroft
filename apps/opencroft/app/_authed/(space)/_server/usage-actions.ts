import { createServerFn } from '@tanstack/react-start'
import type { SpaceUsageSeries, UsageGrouping, UsagePeriod } from 'ui/admin/space-usage'

import { queryChatUsage } from '@/app/_authed/(agent)/_server/chat-usage-store'
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
