'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { SpaceUsage, type SpaceUsageSeries, type UsageGrouping, type UsagePeriod } from 'ui/admin/space-usage'

import { getSpaceUsage, resetSpaceUsage } from '@/app/_authed/(space)/_server/usage-actions'

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

  // One query, run on every change and again after a reset. Each run starts
  // its own request and a superseded one still lands — a half-picked custom
  // range in particular queries everything since its start — so only the
  // newest request is allowed to write the result.
  const latestRequest = useRef(0)
  const load = useCallback(async () => {
    const request = ++latestRequest.current
    const next = await getSpaceUsage({ data: { grouping, period } })
    if (request === latestRequest.current) {
      setSeries(next)
    }
  }, [grouping, period])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <SpaceUsage
      series={series}
      grouping={grouping}
      onGroupingChange={setGrouping}
      period={period}
      onPeriodChange={setPeriod}
      // Re-queried rather than edited in place, so what the page shows after
      // the write is what the store holds — the same way it is after a switch.
      onReset={async (target) => {
        await resetSpaceUsage({ data: { period: target } })
        await load()
      }}
    />
  )
}
