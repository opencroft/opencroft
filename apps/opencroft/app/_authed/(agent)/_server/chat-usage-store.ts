import { chatUsageTurn, chatUsageTurnModel, db } from '@opencroft/db'
import type { UsageTokens } from 'agent-chat/components/usage-cost'
import type { SessionCost, TurnQuota, TurnTokenUsage } from 'agent-client/types'
import { and, eq, gte, lte, sum } from 'drizzle-orm'
import type { SpaceUsagePoint, SpaceUsageSeries, UsageGrouping, UsagePeriod } from 'ui/admin/space-usage'

import { partsOfSessionKey } from '@/app/_authed/(group-chats)/_shared/session-key'

// Per-turn usage accounting for agent-chat sessions, read off the turn_end
// event the engine emits. One row per turn that reported a spend; the table's
// schema comment carries the reasoning for keeping these rows OUT of
// UsageRollupDay, and this module is the only writer.
//
// adapterId/model/cost are the event's own — already resolved (real harness,
// resolved model) and already differenced (this turn's own cost, not the
// session's running total) at the boundary in agent-client's settleTurn, so
// nothing here re-derives them from a session lookup.
//
// Not every harness prices sessions or names the model it ran, and a harness
// may report only the total — every optional input degrades to null/zero
// rather than the row being dropped: the total is the figure the day's
// accounting keys on, and a turn that ran is a turn that ran.

/** UTC date of the turn's end — the same 'YYYY-MM-DD' bucket UsageRollupDay uses. */
export function usageDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10)
}

/**
 * The counter columns both usage tables spell identically — and the one place
 * the "an unreported counter stores as zero" rule above is applied.
 */
function tokenColumns(usage: TurnTokenUsage) {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens,
  }
}

export async function recordChatUsageTurn(input: {
  sessionId: string
  /**
   * The session's key, when it has one. Only a group-chat thread's key names an
   * agent, so this is what the `agent` column is derived from — decoded here,
   * with the rest of the row's defaulting, rather than by each caller.
   */
  sessionKey?: string
  adapterId?: string
  model?: string
  at?: Date
  usage: TurnTokenUsage
  cost?: SessionCost
  /**
   * The harness's per-model breakdown, when its `_meta` carried one (the
   * claude bridge's `_meta.quota`, shaped like codex-acp's) — written as the
   * turn's ChatUsageTurnModel rows, which are what a model-grouped read sums
   * (the table's schema comment carries why those, not the turn's own).
   */
  quota?: TurnQuota
}): Promise<void> {
  const [turn] = await db
    .insert(chatUsageTurn)
    .values({
      day: usageDay(input.at),
      sessionId: input.sessionId,
      adapterId: input.adapterId ?? 'unknown',
      model: input.model ?? null,
      agent: input.sessionKey ? (partsOfSessionKey(input.sessionKey)?.agentSlug ?? null) : null,
      ...tokenColumns(input.usage),
      costAmount: input.cost?.amount ?? null,
      costCurrency: input.cost?.currency ?? null,
    })
    .returning({ id: chatUsageTurn.id })

  // The reported breakdown, or — when the harness gave none — the turn's own
  // usage standing in as its one and only "model" row. Always at least one
  // row per recorded turn this way, so a model-grouped read never needs a
  // fallback branch for "no breakdown yet".
  const modelRow = (model: string | null, usage: TurnTokenUsage) => ({ turnId: turn.id, model, ...tokenColumns(usage) })
  await db
    .insert(chatUsageTurnModel)
    .values(
      input.quota?.modelUsage?.length
        ? input.quota.modelUsage.map((entry) => modelRow(entry.model, entry.tokenCount))
        : [modelRow(input.model ?? null, input.usage)],
    )
}

/**
 * The authoritative token account for one session, as of now: a plain SUM of
 * ChatUsageTurn's own five counters (the turn's main-loop figures, not the
 * per-model breakdown — the same rows the account this mirrors, the ring's
 * `sessionTokens`, has always meant), grouped down to a single row by
 * `sessionId` in the database rather than fetched-and-summed client-side.
 *
 * Every recorded turn's counters default to 0, never NULL (see
 * `tokenColumns`), so SUM is NULL here only when the session has NO row at
 * all — reported as absent (`undefined`), never as an all-zero account, the
 * same "absent, not measured" distinction `UsageTokens` keeps everywhere
 * else. This is the BASE a session's client seeds its running token account
 * from at open; the client adds its own live turn_end increments on top
 * rather than re-fetching this on every turn (see use-acp-session's
 * `mergeTokenAccounts`).
 */
export async function queryChatUsageTokensBySession(sessionId: string): Promise<UsageTokens | undefined> {
  const [row] = await db
    .select({
      total: sum(chatUsageTurn.totalTokens),
      input: sum(chatUsageTurn.inputTokens),
      output: sum(chatUsageTurn.outputTokens),
      cacheRead: sum(chatUsageTurn.cacheReadTokens),
      cacheWrite: sum(chatUsageTurn.cacheWriteTokens),
    })
    .from(chatUsageTurn)
    .where(eq(chatUsageTurn.sessionId, sessionId))

  if (!row || row.total === null) {
    return undefined
  }
  return {
    total: Number(row.total),
    input: Number(row.input),
    output: Number(row.output),
    cacheRead: Number(row.cacheRead),
    cacheWrite: Number(row.cacheWrite),
  }
}

// ── Read side: SpaceUsage series ────────────────────────────────────────────
//
// v1 aggregates INSTANCE-WIDE — every recorded turn, not scoped to a space. A
// session key names a group-chat agent but not a space; deriving one needs a
// chat→space resolution that is its own design step, left for a separate
// design decision (this still lands on the space settings
// page per the product ask — the instance-wide scope is the provisional
// part, not the placement).

const ALL_SERIES_KEY = 'all'
const UNKNOWN_GROUP_KEY = '__unknown__'
const OTHER_SERIES_KEY = '__other__'
// SpaceUsage assigns colour by series position from a five-entry palette; a
// sixth group would repeat one, so the tail folds into one "Other" series
// instead of either overflowing the palette or being dropped silently.
const MAX_SERIES = 5

function addDaysUTC(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return usageDay(date)
}

/** Inclusive UTC day bounds for a period. A custom period keeps whichever end the reader picked and leaves the other open. */
function dayRangeOf(period: UsagePeriod): { from?: string; to?: string } {
  const today = usageDay()
  switch (period.kind) {
    case 'today':
      return { from: today, to: today }
    case '7d':
      return { from: addDaysUTC(today, -6), to: today }
    case '30d':
      return { from: addDaysUTC(today, -29), to: today }
    case 'custom': {
      const { from, to } = period
      return from && to && from > to ? { from: to, to: from } : { from, to }
    }
  }
}

/** The bounds as one turn-table predicate — the read and the reset select the same rows by construction. */
function dayWhereOf(range: { from?: string; to?: string }) {
  return and(
    range.from ? gte(chatUsageTurn.day, range.from) : undefined,
    range.to ? lte(chatUsageTurn.day, range.to) : undefined,
  )
}

function fullDayRange(from: string, to: string): string[] {
  const days: string[] = []
  for (let day = from; day <= to; day = addDaysUTC(day, 1)) {
    days.push(day)
  }
  return days
}

/**
 * The one date axis every series in the response shares (see SpaceUsageProps'
 * doc on why they must). A bounded period is zero-filled in full, even over
 * days with no rows; an open-ended custom bound falls back to the earliest/
 * latest day actually recorded, so an unbounded query does not walk to the
 * start of time.
 */
function dateAxisOf(range: { from?: string; to?: string }, rows: { day: string }[]): string[] {
  if (range.from && range.to) {
    return fullDayRange(range.from, range.to)
  }
  if (rows.length === 0) {
    return []
  }
  const days = rows.map((row) => row.day).sort()
  return fullDayRange(range.from ?? days[0], range.to ?? days[days.length - 1])
}

/**
 * A (series, day) cell mid-aggregation: the chart's own point shape, minus the
 * date the cell is already keyed by. An absent `cost` means no priced turn
 * landed in the cell — the same absence the chart reads as "not priced".
 */
type UsageCell = Omit<SpaceUsagePoint, 'date'>

function emptyCell(): UsageCell {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/** The series a (agent, model) pair belongs to, before any overflow folding. */
function groupKeyOf(grouping: UsageGrouping, agent: string | null, model: string | null): string {
  if (grouping === 'all') {
    return ALL_SERIES_KEY
  }
  return (grouping === 'agent' ? agent : model) ?? UNKNOWN_GROUP_KEY
}

// The day is a fixed-width suffix, so whatever a series is named, two
// different (series, day) pairs cannot produce the same key.
const cellKey = (seriesKey: string, day: string) => `${seriesKey}|${day}`

function labelOf(grouping: UsageGrouping, key: string): string {
  if (key === OTHER_SERIES_KEY) {
    return 'Other'
  }
  if (key === ALL_SERIES_KEY) {
    return 'All'
  }
  if (key === UNKNOWN_GROUP_KEY) {
    return grouping === 'agent' ? 'Direct chats' : 'Unknown model'
  }
  return key
}

/**
 * Aggregate ChatUsageTurnModel (joined to its turn for day/agent) into the
 * SpaceUsage chart's series shape: one series for `all`, one per agent or
 * model otherwise, every series padded to the same date axis (see
 * dateAxisOf). Token counts come from the MODEL rows, never the turn's own,
 * and every recorded turn has at least one — see the ChatUsageTurnModel
 * schema comment for why those rows, not the turn's, are the true spend.
 *
 * Cost has no per-model breakdown, so it stays turn-level and is aggregated
 * SEPARATELY: for `model` grouping a turn's cost attributes to its own
 * resolved model (chatUsageTurn.model), which can differ from some of that
 * turn's model rows (a subagent's, say) — stated attribution, not a
 * measurement, same as the schema comment on costAmount already notes.
 *
 * Both reads GROUP BY the full (day, agent, model) triple in SQL, regardless
 * of `grouping` — the database sums the counters instead of every matching
 * turn/model row crossing the wire. The result set stays one row per triple
 * actually recorded (not one per turn), so the JS below still does the
 * grouping-dependent work: ranking groups, folding the tail into "Other",
 * building the date axis and padding cells — unchanged, just fed rows that
 * are already summed instead of raw ones.
 */
export async function queryChatUsage(grouping: UsageGrouping, period: UsagePeriod): Promise<SpaceUsageSeries[]> {
  const range = dayRangeOf(period)
  const where = dayWhereOf(range)

  // Nothing links the two reads, so they go out together.
  const [tokenRows, costRows] = await Promise.all([
    db
      .select({
        day: chatUsageTurn.day,
        agent: chatUsageTurn.agent,
        model: chatUsageTurnModel.model,
        // sum() over a bigint column comes back as a driver string; mapWith
        // decodes it to a number, and is only ever invoked for a non-null
        // result — every group here has at least one contributing row (it
        // exists because GROUP BY produced it), so these sums are never SQL
        // NULL and mapWith(Number) never sees one.
        inputTokens: sum(chatUsageTurnModel.inputTokens).mapWith(Number),
        outputTokens: sum(chatUsageTurnModel.outputTokens).mapWith(Number),
        cacheReadTokens: sum(chatUsageTurnModel.cacheReadTokens).mapWith(Number),
        cacheWriteTokens: sum(chatUsageTurnModel.cacheWriteTokens).mapWith(Number),
        totalTokens: sum(chatUsageTurnModel.totalTokens).mapWith(Number),
      })
      .from(chatUsageTurnModel)
      .innerJoin(chatUsageTurn, eq(chatUsageTurnModel.turnId, chatUsageTurn.id))
      .where(where)
      .groupBy(chatUsageTurn.day, chatUsageTurn.agent, chatUsageTurnModel.model),
    db
      .select({
        day: chatUsageTurn.day,
        agent: chatUsageTurn.agent,
        model: chatUsageTurn.model,
        // Left undecoded (driver string | null): SQL SUM ignores NULL
        // costAmount rows and itself returns NULL — not 0 — for a group
        // where every turn was unpriced, which is the "absent, not
        // measured" cost keeps end to end. Parsed to a number below, only
        // once known non-null.
        costAmount: sum(chatUsageTurn.costAmount),
      })
      .from(chatUsageTurn)
      .where(where)
      .groupBy(chatUsageTurn.day, chatUsageTurn.agent, chatUsageTurn.model),
  ])

  const dates = dateAxisOf(range, tokenRows)
  if (dates.length === 0) {
    return []
  }

  // Rank groups by total tokens; past the chart's colours (see MAX_SERIES)
  // the tail folds into one "Other" series rather than being dropped.
  const totalsByGroup = new Map<string, number>()
  for (const row of tokenRows) {
    const group = groupKeyOf(grouping, row.agent, row.model)
    totalsByGroup.set(group, (totalsByGroup.get(group) ?? 0) + row.totalTokens)
  }
  const ranked = [...totalsByGroup.entries()].sort((a, b) => b[1] - a[1]).map(([group]) => group)
  const kept = ranked.slice(0, MAX_SERIES)
  const keptSet = new Set(kept)
  const seriesKeys = ranked.length > MAX_SERIES ? [...kept, OTHER_SERIES_KEY] : kept
  const seriesKeyOf = (group: string) => (keptSet.has(group) ? group : OTHER_SERIES_KEY)

  // One cell per (series, day). Tokens and cost are summed over two different
  // row sets (see the function doc on why cost cannot share the model rows'
  // grouping) into the SAME cell map.
  const cells = new Map<string, UsageCell>()
  const cellOf = (row: { day: string; agent: string | null; model: string | null }): UsageCell => {
    const key = cellKey(seriesKeyOf(groupKeyOf(grouping, row.agent, row.model)), row.day)
    let cell = cells.get(key)
    if (!cell) {
      cell = emptyCell()
      cells.set(key, cell)
    }
    return cell
  }
  for (const row of tokenRows) {
    const cell = cellOf(row)
    cell.inputTokens += row.inputTokens
    cell.outputTokens += row.outputTokens
    cell.cacheReadTokens += row.cacheReadTokens
    cell.cacheWriteTokens += row.cacheWriteTokens
    cell.totalTokens += row.totalTokens
  }
  for (const row of costRows) {
    if (row.costAmount === null) {
      continue
    }
    const cell = cellOf(row)
    cell.cost = (cell.cost ?? 0) + Number(row.costAmount)
  }

  return seriesKeys.map((seriesKey) => ({
    key: seriesKey,
    label: labelOf(grouping, seriesKey),
    points: dates.map((date) => ({ date, ...(cells.get(cellKey(seriesKey, date)) ?? emptyCell()) })),
  }))
}

// ── Reset ───────────────────────────────────────────────────────────────────

/**
 * Deletes every turn recorded in the period — the Usage page's reset, and the
 * one write this module makes that is not a recording. Same v1 scope as the
 * read: instance-wide. The turn's model rows go with it (the foreign key
 * cascades), so a model-grouped read afterwards has nothing orphaned to sum.
 *
 * Only a BOUNDED period is accepted. The read tolerates a half-picked custom
 * range by leaving that end open; a delete that did the same would wipe to
 * the start (or end) of time on a choice the reader had not finished making.
 * Returns how many turns went.
 */
export async function deleteChatUsage(period: UsagePeriod): Promise<number> {
  const range = dayRangeOf(period)
  if (!range.from || !range.to) {
    throw new Error('A usage reset needs both ends of its period')
  }
  const removed = await db.delete(chatUsageTurn).where(dayWhereOf(range)).returning({ id: chatUsageTurn.id })
  return removed.length
}
