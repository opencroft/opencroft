// Orchestration only -- deliberately no @opencroft/terminal or graph/space
// import here. WHICH places agents run in and HOW to exec in one is host
// knowledge: the caller resolves both and hands them in, so this stays
// testable without a live terminal or a loaded space registry.

import { composeDailyRollupMessage } from './message'
import { buildRollupCommand } from './rollup-script'
import { getUsageRollupConfig, listRollupRowsForDay, upsertRollupRows } from './store'
import type { RollupRow } from './types'

export interface UsageRollupTickDeps {
  /** Distinct places agents run in, to scan (agent nodes can share one): the host's ids for them. */
  places: string[]
  /** Runs `command` in `place` and resolves its stdout. */
  execIn: (place: string, command: string) => Promise<string>
  now?: Date
}

export interface PendingDelivery {
  day: string
  message: string
}

export interface UsageRollupTickResult {
  scannedPlaces: number
  rowsUpserted: number
  pendingDelivery: PendingDelivery | null
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Pure decision: which day (if any) is due for chat delivery right now.
 * At most once per calendar day, and only once the UTC hour has passed
 * deliverAfterHour -- so a runaway day is visible by then, not only the
 * morning after. UTC throughout, matching `day`: the
 * transcript timestamps rollup-script buckets by are UTC ISO-8601, with no
 * local-timezone concept anywhere in this pipeline to convert against.
 *
 * Deliberately never catches up a missed day: this only ever asks about
 * TODAY, so if the app is down for a whole day's delivery window, that day's
 * message is simply never sent. The row itself is not lost -- it stays in
 * UsageRollupDay, queryable -- only the chat notification is skipped, which
 * is an acceptable trade for not surprising anyone with a pile of stale
 * rollups landing at once on restart.
 */
export function dueDeliveryDay(
  now: Date,
  deliverAfterHour: number,
  lastDeliveredDay: string | undefined,
): string | null {
  const today = isoDay(now)
  if (lastDeliveredDay === today) {
    return null
  }
  if (now.getUTCHours() < deliverAfterHour) {
    return null
  }
  return today
}

/** Execs the rollup script in every place and merges their (day, agent, model) rows. */
export async function collectRollupRows(
  deps: Pick<UsageRollupTickDeps, 'places' | 'execIn'>,
  sinceDay: string,
): Promise<RollupRow[]> {
  const command = buildRollupCommand(sinceDay)
  const byKey = new Map<string, RollupRow>()
  for (const place of deps.places) {
    let output: string
    try {
      output = await deps.execIn(place, command)
    } catch (err) {
      console.error(`[usage-rollup] exec failed in ${place}`, err)
      continue
    }
    let parsed: RollupRow[]
    try {
      parsed = JSON.parse(output) as RollupRow[]
    } catch (err) {
      console.error(`[usage-rollup] could not parse rollup output from ${place}`, err)
      continue
    }
    for (const row of parsed) {
      const key = `${row.day}${String.fromCharCode(0)}${row.agent}${String.fromCharCode(0)}${row.model}`
      const existing = byKey.get(key)
      if (existing) {
        // Belt-and-suspenders: places are expected to own disjoint
        // /home/node/.claude/projects trees, but if two ever overlap for the
        // same bucket, sum rather than let the second exec silently win.
        existing.requests += row.requests
        existing.rawInputTokens += row.rawInputTokens
        existing.cacheWriteTokens += row.cacheWriteTokens
        existing.cacheReadTokens += row.cacheReadTokens
        existing.outputTokens += row.outputTokens
        existing.coldPrimeRequests += row.coldPrimeRequests
        existing.coldPrimeTokens += row.coldPrimeTokens
      } else {
        byKey.set(key, { ...row })
      }
    }
  }
  return Array.from(byKey.values())
}

/**
 * One scheduler tick: re-derive yesterday+today's rows from every place,
 * persist them, and decide whether today's rollup is due in chat. Does NOT
 * send the message or mark it delivered -- the caller does that (and only
 * commits lastDeliveredDay once the send actually succeeds), since chat
 * delivery is host/group-chat knowledge this package does not have.
 *
 * `enabled: false` gates the WHOLE tick, not just the chat message -- it
 * stops the scans too, so turning the rollup off actually stops exec'ing
 * into every agent's place every 15 minutes instead of only silencing its
 * output.
 */
export async function runUsageRollupTick(deps: UsageRollupTickDeps): Promise<UsageRollupTickResult> {
  const config = await getUsageRollupConfig()
  if (!config.enabled) {
    return { scannedPlaces: 0, rowsUpserted: 0, pendingDelivery: null }
  }

  const now = deps.now ?? new Date()
  const sinceDay = isoDay(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  const rows = await collectRollupRows(deps, sinceDay)
  if (rows.length > 0) {
    await upsertRollupRows(rows)
  }

  let pendingDelivery: PendingDelivery | null = null
  const deliverDay = dueDeliveryDay(now, config.deliverAfterHour, config.lastDeliveredDay)
  if (deliverDay) {
    const dayRows = await listRollupRowsForDay(deliverDay)
    pendingDelivery = { day: deliverDay, message: composeDailyRollupMessage(deliverDay, dayRows) }
  }

  return { scannedPlaces: deps.places.length, rowsUpserted: rows.length, pendingDelivery }
}
