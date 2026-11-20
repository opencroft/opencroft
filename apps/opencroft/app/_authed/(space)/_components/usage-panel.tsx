'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { SpaceUsage, type UsageGrouping, type UsagePeriod } from 'ui/admin/space-usage'

import type { ChatUsageAnswer, ChatUsageQuery } from '@/app/_authed/(agent)/_server/chat-usage-store'

const EMPTY: ChatUsageAnswer = { series: [], options: [], groups: [] }
// One identity for "nothing chosen": the choice is a dependency of the query
// below, and a fresh empty array per render would refetch on every render.
const NONE_CHOSEN: string[] = []

/**
 * A Usage page: token and cost trends over the period, the grouping and the
 * groups of it the reader picks, over whatever turns `query` reads. A space's
 * settings and the instance's Administration both draw this, each with its
 * own query. The choices live as local state rather than the URL (same choice
 * audit-settings.tsx made for its own filters), so they hold while the reader
 * stays on the page and start over on the next visit, refetching on change,
 * same as that page. Each grouping keeps its own choice of groups, since a
 * key means a different group in each; switching back to a grouping finds
 * the choice it had.
 *
 * `query` must keep its identity while its scope does: a new function is a
 * new scope and refetches. Without `onReset` the page offers no reset.
 */
export function UsagePanel({
  query,
  onReset,
  groupings,
  className,
}: {
  query: (query: ChatUsageQuery) => Promise<ChatUsageAnswer>
  onReset?: (period: UsagePeriod) => Promise<void>
  groupings?: UsageGrouping[]
  className?: string
}) {
  const [grouping, setGrouping] = useState<UsageGrouping>('all')
  const [period, setPeriod] = useState<UsagePeriod>({ kind: '7d' })
  const [chosenBy, setChosenBy] = useState<Partial<Record<UsageGrouping, string[]>>>({})
  // The answer with the grouping it was asked for: until a grouping switch's
  // own answer lands, the last one's options belong to another grouping and
  // are not offered under this one.
  const [answered, setAnswered] = useState<{ grouping: UsageGrouping; answer: ChatUsageAnswer }>({
    grouping,
    answer: EMPTY,
  })
  // Every label a grouping's answers have given, kept for the page's life: a
  // chosen group the period lacks, or one shown while a grouping switch's
  // answer is pending, is still named, not shown by its key (a space's id).
  const [labelsBy, setLabelsBy] = useState<Partial<Record<UsageGrouping, Record<string, string>>>>({})
  const chosen = chosenBy[grouping] ?? NONE_CHOSEN

  // One query, run on every change and again after a reset. Each run starts
  // its own request and a superseded one still lands — a half-picked custom
  // range in particular queries everything since its start — so only the
  // newest request is allowed to write the result.
  const latestRequest = useRef(0)
  const load = useCallback(async () => {
    const request = ++latestRequest.current
    const next = await query({ grouping, period, chosen })
    if (request === latestRequest.current) {
      setAnswered({ grouping, answer: next })
      setLabelsBy((by) => ({
        ...by,
        [grouping]: { ...by[grouping], ...Object.fromEntries(next.options.map((o) => [o.key, o.label])) },
      }))
    }
  }, [query, grouping, period, chosen])

  useEffect(() => {
    void load()
  }, [load])

  const { answer } = answered
  const offered = answered.grouping === grouping ? answer.options : []
  const offeredKeys = new Set(offered.map((option) => option.key))
  const known = labelsBy[grouping] ?? {}
  const options = [
    ...offered,
    ...chosen
      .filter((key) => !offeredKeys.has(key) && Object.hasOwn(known, key))
      .map((key) => ({ key, label: known[key] })),
  ]
  return (
    <SpaceUsage
      series={answer.series}
      groups={answer.groups}
      grouping={grouping}
      onGroupingChange={setGrouping}
      groupings={groupings}
      period={period}
      onPeriodChange={setPeriod}
      options={options}
      chosen={chosen}
      onChosenChange={(keys) => setChosenBy((by) => ({ ...by, [grouping]: keys }))}
      // Re-queried rather than edited in place, so what the page shows after
      // the write is what the store holds — the same way it is after a switch.
      onReset={
        onReset
          ? async (target) => {
              await onReset(target)
              await load()
            }
          : undefined
      }
      className={className}
    />
  )
}
