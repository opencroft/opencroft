import { createServerFn } from '@tanstack/react-start'
import type { SpaceUsageSeries, UsageGrouping, UsagePeriod } from 'ui/admin/space-usage'

import { deleteChatUsage, queryChatUsage } from '@/app/_authed/(agent)/_server/chat-usage-store'
import { registry } from '@/app/_authed/(space)/_server/actions-impl'
import { requireSessionServerFn } from '@/app/_server/require-session'

export interface SpaceUsageQuery {
  slug: string
  grouping: UsageGrouping
  period: UsagePeriod
}

async function resolveSpaceId(slug: string): Promise<string> {
  const space = (await registry()).getBySlug(slug)
  if (!space) {
    throw new Error(`Unknown space: ${slug}`)
  }
  return space.id
}

// The space settings page's Usage section: the spend recorded in this space.
export const getSpaceUsage = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((query: SpaceUsageQuery) => query)
  .handler(async ({ data }): Promise<SpaceUsageSeries[]> => {
    await requireSessionServerFn()
    return queryChatUsage(await resolveSpaceId(data.slug), data.grouping, data.period)
  })

// The Usage section's reset: every turn this space recorded in the period goes.
export const resetSpaceUsage = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { slug: string; period: UsagePeriod }) => data)
  .handler(async ({ data }): Promise<{ removed: number }> => {
    await requireSessionServerFn()
    return { removed: await deleteChatUsage(await resolveSpaceId(data.slug), data.period) }
  })
