import { db, setting, usageRollupDay } from '@opencroft/db'
import { asc, eq, gte } from 'drizzle-orm'

import type { RollupRow } from './types'

// ── Rollup rows ──────────────────────────────────────────────────────────
//
// Each tick recomputes a (day, agent, model) bucket from scratch (see
// rollup-script.ts) and overwrites the stored row for it — this table is
// never incremented, so a re-run after a restart or a mid-day re-scan is
// naturally idempotent instead of needing its own cursor/dedup state.

export async function upsertRollupRows(rows: RollupRow[]): Promise<void> {
  for (const row of rows) {
    await db
      .insert(usageRollupDay)
      .values(row)
      .onConflictDoUpdate({
        target: [usageRollupDay.day, usageRollupDay.agent, usageRollupDay.model],
        set: {
          requests: row.requests,
          rawInputTokens: row.rawInputTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          cacheReadTokens: row.cacheReadTokens,
          outputTokens: row.outputTokens,
          coldPrimeRequests: row.coldPrimeRequests,
          coldPrimeTokens: row.coldPrimeTokens,
          updatedAt: new Date(),
        },
      })
  }
}

export async function listRollupRowsForDay(day: string): Promise<RollupRow[]> {
  const rows = await db
    .select()
    .from(usageRollupDay)
    .where(eq(usageRollupDay.day, day))
    .orderBy(asc(usageRollupDay.agent), asc(usageRollupDay.model))
  return rows.map(toRollupRow)
}

export async function listRollupRowsSince(sinceDay: string): Promise<RollupRow[]> {
  const rows = await db
    .select()
    .from(usageRollupDay)
    .where(gte(usageRollupDay.day, sinceDay))
    .orderBy(asc(usageRollupDay.day), asc(usageRollupDay.agent), asc(usageRollupDay.model))
  return rows.map(toRollupRow)
}

function toRollupRow(row: typeof usageRollupDay.$inferSelect): RollupRow {
  return {
    day: row.day,
    agent: row.agent,
    model: row.model,
    requests: row.requests,
    rawInputTokens: row.rawInputTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    cacheReadTokens: row.cacheReadTokens,
    outputTokens: row.outputTokens,
    coldPrimeRequests: row.coldPrimeRequests,
    coldPrimeTokens: row.coldPrimeTokens,
  }
}

// ── Schedule / delivery config ──────────────────────────────────────────
//
// Same shape as db-backups' BackupScheduleConfig: one JSON row in the shared
// Setting table, read fresh every tick so a change while the app runs is
// picked up on the next one rather than needing a restart.

export interface UsageRollupConfig {
  enabled: boolean
  /** Which agent the rollup message is sent as (must be a member of deliverThreadRef's chat). */
  deliverAgentName: string
  /** A group-chat thread ref, e.g. "my-space:alice:usage-reports". */
  deliverThreadRef: string
  /** UTC hour (0-23) after which the first tick of a day delivers that day's rollup so far. */
  deliverAfterHour: number
  /** The last calendar day ('YYYY-MM-DD') whose rollup was actually delivered. */
  lastDeliveredDay?: string
}

const USAGE_ROLLUP_SETTING_ID = 'usage-rollup-schedule'

const DEFAULT_USAGE_ROLLUP_CONFIG: UsageRollupConfig = {
  enabled: false,
  deliverAgentName: 'alice',
  deliverThreadRef: 'my-space:alice:usage-reports',
  deliverAfterHour: 12,
}

export async function getUsageRollupConfig(): Promise<UsageRollupConfig> {
  const row = await db.query.setting.findFirst({ where: eq(setting.id, USAGE_ROLLUP_SETTING_ID) })
  if (!row) {
    return DEFAULT_USAGE_ROLLUP_CONFIG
  }
  return { ...DEFAULT_USAGE_ROLLUP_CONFIG, ...(JSON.parse(row.data) as Partial<UsageRollupConfig>) }
}

export async function setUsageRollupConfig(patch: Partial<UsageRollupConfig>): Promise<UsageRollupConfig> {
  const current = await getUsageRollupConfig()
  const next = { ...current, ...patch }
  await db
    .insert(setting)
    .values({ id: USAGE_ROLLUP_SETTING_ID, data: JSON.stringify(next) })
    .onConflictDoUpdate({
      target: setting.id,
      set: { data: JSON.stringify(next), updatedAt: new Date() },
    })
  return next
}
