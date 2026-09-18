'use client'

import { useEffect, useState } from 'react'
import { SpaceUsage, type SpaceUsageSeries, type UsageGrouping, type UsagePeriod } from 'ui/admin/space-usage'

import { getSpaceUsage } from '@/app/_authed/(space)/_server/usage-actions'

/**
 * The Usage section of a space's settings: token and cost trends over the
 * period and grouping the reader picks. Grouping/period live as local state
 * rather than the URL (same choice audit-settings.tsx made for its own
 * filters) — refetching on change, same as that page.
 *
 * INSTANCE-WIDE for v1, not scoped to this space: see the comment on
 * queryChatUsage in chat-usage-store.ts for why.
 */
export function SpaceUsageSettings() {
  const [grouping, setGrouping] = useState<UsageGrouping>('all')
  const [period, setPeriod] = useState<UsagePeriod>({ kind: '7d' })
  const [series, setSeries] = useState<SpaceUsageSeries[]>([])

  useEffect(() => {
    // Each change starts its own query and a superseded one still lands — a
    // half-picked custom range in particular queries everything since its start
    // — so only the newest request is allowed to write the result.
    let latest = true
    void getSpaceUsage({ data: { grouping, period } }).then((next) => {
      if (latest) {
        setSeries(next)
      }
    })
    return () => {
      latest = false
    }
  }, [grouping, period])

  return (
    <SpaceUsage
      series={series}
      grouping={grouping}
      onGroupingChange={setGrouping}
      period={period}
      onPeriodChange={setPeriod}
    />
  )
}
