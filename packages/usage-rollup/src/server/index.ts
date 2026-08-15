import { createServerFn } from '@tanstack/react-start'

import type { UsageRollupConfig } from '../store'
import { getUsageRollupConfig, listRollupRowsForDay, listRollupRowsSince, setUsageRollupConfig } from '../store'
import type { RollupRow } from '../types'

export type { RollupRow, UsageRollupConfig }

// No UI consumes these yet; they exist so the token-spend reduction analysis
// (and any future dashboard) can read stored rollups without a direct DB query.

export const listUsageRollupSince = createServerFn()
  .inputValidator((sinceDay: string) => sinceDay)
  .handler(async ({ data: sinceDay }): Promise<RollupRow[]> => {
    return listRollupRowsSince(sinceDay)
  })

export const listUsageRollupForDay = createServerFn()
  .inputValidator((day: string) => day)
  .handler(async ({ data: day }): Promise<RollupRow[]> => {
    return listRollupRowsForDay(day)
  })

export const getUsageRollupSchedule = createServerFn().handler(async (): Promise<UsageRollupConfig> => {
  return getUsageRollupConfig()
})

export const setUsageRollupSchedule = createServerFn({ method: 'POST' })
  .inputValidator((data: Partial<UsageRollupConfig>) => data)
  .handler(async ({ data }): Promise<UsageRollupConfig> => {
    return setUsageRollupConfig(data)
  })
