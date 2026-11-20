'use client'

import { useCallback } from 'react'
import type { UsagePeriod } from 'ui/admin/space-usage'

import type { ChatUsageQuery } from '@/app/_authed/(agent)/_server/chat-usage-store'
import { UsagePanel } from '@/app/_authed/(space)/_components/usage-panel'
import { getSpaceUsage, resetSpaceUsage } from '@/app/_authed/(space)/_server/usage-actions'

/**
 * The Usage section of a space's settings: the Usage page over this space's
 * spend. Both the read and the reset cover this space only.
 */
export function SpaceUsageSettings({ spaceSlug }: { spaceSlug: string }) {
  const query = useCallback(
    (query: ChatUsageQuery) => getSpaceUsage({ data: { slug: spaceSlug, ...query } }),
    [spaceSlug],
  )
  const reset = useCallback(
    async (period: UsagePeriod) => {
      await resetSpaceUsage({ data: { slug: spaceSlug, period } })
    },
    [spaceSlug],
  )
  return <UsagePanel query={query} onReset={reset} />
}
