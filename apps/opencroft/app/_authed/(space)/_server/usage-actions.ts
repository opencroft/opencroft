import { createServerFn } from '@tanstack/react-start'
import type { UsagePeriod } from 'ui/admin/space-usage'

import {
  type ChatUsageAnswer,
  type ChatUsageQuery,
  deleteChatUsage,
  queryChatUsage,
} from '@/app/_authed/(agent)/_server/chat-usage-store'
import { registry } from '@/app/_authed/(space)/_server/actions-impl'

export interface SpaceUsageQuery extends ChatUsageQuery {
  slug: string
}

async function resolveSpaceId(slug: string): Promise<string> {
  const space = (await registry()).getBySlug(slug)
  if (!space) {
    throw new Error(`Unknown space: ${slug}`)
  }
  return space.id
}

// The space settings page's Usage section: the spend recorded in this space,
// the groups of the grouping shown that the reader may choose from, and each
// group's figures.
export const getSpaceUsage = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((query: SpaceUsageQuery) => query)
  .handler(async ({ data }): Promise<ChatUsageAnswer> => {
    return queryChatUsage(await resolveSpaceId(data.slug), data.grouping, data.period, data.chosen)
  })

// The Usage section's reset: every turn this space recorded in the period goes.
export const resetSpaceUsage = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { slug: string; period: UsagePeriod }) => data)
  .handler(async ({ data }): Promise<{ removed: number }> => {
    return { removed: await deleteChatUsage(await resolveSpaceId(data.slug), data.period) }
  })
