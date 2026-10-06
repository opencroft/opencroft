import { chatUsageTurn, chatUsageTurnModel, db } from '@opencroft/db'
import type { UsageTokens } from 'agent-chat/components/usage-cost'
import type { SessionCost, TurnQuota, TurnTokenUsage } from 'agent-client/types'
import { and, eq, gte, lte, sql, sum } from 'drizzle-orm'
import type { SpaceUsagePoint, SpaceUsageSeries, UsageGrouping, UsagePeriod } from 'ui/admin/space-usage'

import { turnModelUsage } from '@/app/_authed/(agent)/_lib/turn-model-usage'
import { spaceIdForSessionKey } from '@/app/_authed/(group-chats)/_server/thread-space'
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
   * agent and leads to a space, so this is what the `agent` and `spaceId`
   * columns are derived from — here, with the rest of the row's defaulting,
   * rather than by each caller.
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
  // One instant for both time columns: the day key a range filters on and the
  // timestamp an hourly read cuts from must never disagree about which
  // bucket a turn is in, so neither is left to a column default.
  const at = input.at ?? new Date()
  // Resolved now and stored, never re-derived at read time: the spend stays in
  // the space it was made in, whatever later happens to the thread or its chat.
  const spaceId = input.sessionKey ? await spaceIdForSessionKey(input.sessionKey) : null
  const [turn] = await db
    .insert(chatUsageTurn)
    .values({
      day: usageDay(at),
      createdAt: at,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey ?? null,
      adapterId: input.adapterId ?? 'unknown',
      model: input.model ?? null,
      agent: input.sessionKey ? (partsOfSessionKey(input.sessionKey)?.agentSlug ?? null) : null,
      spaceId,
      ...tokenColumns(input.usage),
      costAmount: input.cost?.amount ?? null,
      costCurrency: input.cost?.currency ?? null,
    })
    .returning({ id: chatUsageTurn.id })

  // Always at least one row per recorded turn (see turnModelUsage), so a read
  // over the model rows never needs a fallback branch for "no breakdown yet".
  await db.insert(chatUsageTurnModel).values(
    turnModelUsage(input.usage, input.quota, input.model).map((entry) => ({
      turnId: turn.id,
      model: entry.model,
      ...tokenColumns(entry.tokenCount),
    })),
  )
}

/**
 * Each recorded turn's full token spend, subagents included: its model rows,
 * summed per turn. A turn row's own counters are the main agent loop only (see
 * turnModelUsage), so every token account reads these instead.
 */
function turnTokens() {
  return db
    .select({
      turnId: chatUsageTurnModel.turnId,
      input: sum(chatUsageTurnModel.inputTokens).mapWith(Number).as('input'),
      output: sum(chatUsageTurnModel.outputTokens).mapWith(Number).as('output'),
      cacheRead: sum(chatUsageTurnModel.cacheReadTokens).mapWith(Number).as('cacheRead'),
      cacheWrite: sum(chatUsageTurnModel.cacheWriteTokens).mapWith(Number).as('cacheWrite'),
      total: sum(chatUsageTurnModel.totalTokens).mapWith(Number).as('total'),
    })
    .from(chatUsageTurnModel)
    .groupBy(chatUsageTurnModel.turnId)
    .as('turnTokens')
}

/**
 * The authoritative token account for one session, as of now: a plain SUM of
 * its turns' model rows (subagents included, see turnTokens), grouped down to
 * a single row in the database rather than fetched-and-summed client-side.
 *
 * Every recorded turn has at least one model row, and its counters default to
 * 0, never NULL (see `tokenColumns`), so SUM is NULL here only when the session
 * has NO turn at all — reported as absent (`undefined`), never as an all-zero
 * account, the same "absent, not measured" distinction `UsageTokens` keeps
 * everywhere else. This is the BASE a session's client seeds its running token
 * account from at open; the client adds its own live turn_end increments on
 * top, counted by the same rule, rather than re-fetching this on every turn
 * (see use-acp-session's `mergeTokenAccounts`).
 */
export async function queryChatUsageTokensBySession(sessionId: string): Promise<UsageTokens | undefined> {
  const [row] = await db
    .select({
      total: sum(chatUsageTurnModel.totalTokens),
      input: sum(chatUsageTurnModel.inputTokens),
      output: sum(chatUsageTurnModel.outputTokens),
      cacheRead: sum(chatUsageTurnModel.cacheReadTokens),
      cacheWrite: sum(chatUsageTurnModel.cacheWriteTokens),
    })
    .from(chatUsageTurnModel)
    .innerJoin(chatUsageTurn, eq(chatUsageTurnModel.turnId, chatUsageTurn.id))
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

/** One recorded turn of a session, as a per-thread usage read answers it. */
export interface ChatUsageTurnRecord {
  /** When the turn ended — the row is written at its turn_end. */
  endedAt: Date
  model: string | null
  /** The turn's whole token spend, subagents included (see turnTokens). */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  /** This turn's own cost; null when the harness does not price the session. */
  cost: SessionCost | null
}

/**
 * Every recorded turn of the session bound to `sessionKey`, oldest first,
 * optionally only those that ended at or after `since`. By key rather than id,
 * so a thread whose session was reopened under a new id keeps its earlier
 * turns. Turns recorded before `sessionKey` was stored are not found here.
 */
export async function queryChatUsageTurnsBySessionKey(
  sessionKey: string,
  since?: Date,
): Promise<ChatUsageTurnRecord[]> {
  const tokens = turnTokens()
  const rows = await db
    .select({
      endedAt: chatUsageTurn.createdAt,
      model: chatUsageTurn.model,
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      total: tokens.total,
      costAmount: chatUsageTurn.costAmount,
      costCurrency: chatUsageTurn.costCurrency,
    })
    .from(chatUsageTurn)
    .innerJoin(tokens, eq(tokens.turnId, chatUsageTurn.id))
    .where(
      since
        ? and(eq(chatUsageTurn.sessionKey, sessionKey), gte(chatUsageTurn.createdAt, since))
        : eq(chatUsageTurn.sessionKey, sessionKey),
    )
    .orderBy(chatUsageTurn.createdAt)
  return rows.map((row) => ({
    endedAt: row.endedAt,
    model: row.model,
    tokens: {
      input: row.input,
      output: row.output,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      total: row.total,
    },
    cost: row.costAmount !== null && row.costCurrency ? { amount: row.costAmount, currency: row.costCurrency } : null,
  }))
}

/**
 * Re-key a session's recorded turns when its key moves (a thread or chat
 * rename — see session-key-move). Left behind, a thread's earlier turns are
 * filed under a key nothing reads any more, and whatever reads a thread's
 * usage sees its spend start again from zero.
 */
export async function moveChatUsageTurns(moves: readonly { from: string; to: string }[]): Promise<void> {
  for (const { from, to } of moves) {
    if (!from || !to || from === to) {
      continue
    }
    await db.update(chatUsageTurn).set({ sessionKey: to }).where(eq(chatUsageTurn.sessionKey, from))
  }
}

// ── Read side: SpaceUsage series ────────────────────────────────────────────
//
// Scoped to ONE space: the turns whose `spaceId` was recorded as it (see
// recordChatUsageTurn). A turn no space's chat held is in no space's read, and
// no space's reset removes it.

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

/** The space and bounds as one turn-table predicate — the read and the reset select the same rows by construction. */
function turnWhereOf(spaceId: string, range: { from?: string; to?: string }) {
  return and(
    eq(chatUsageTurn.spaceId, spaceId),
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

// ── Bucket resolution ──────────────────────────────────────────────────────
//
// A window short enough to read by the hour is bucketed by the hour, the
// rest by the day: 24 points a day on a small multiple, while a week of hours
// is already a comb. A row carries both keys — `day`, the UTC day a range
// filters on, and `createdAt`, the instant an hourly cut comes from — written
// from one timestamp (see recordChatUsageTurn), so the two never disagree.

type Resolution = 'hour' | 'day'

/** Up to this many days a bounded window reads by the hour. */
const MAX_HOURLY_DAYS = 3

function resolutionOf(range: { from?: string; to?: string }): Resolution {
  return range.from && range.to && fullDayRange(range.from, range.to).length <= MAX_HOURLY_DAYS ? 'hour' : 'day'
}

/** An hour bucket key — the UTC day and hour, `2026-03-07T14` — the same prefix rule usageDay applies. */
function usageHour(at: Date): string {
  return at.toISOString().slice(0, 13)
}

function addHoursUTC(hour: string, delta: number): string {
  const date = new Date(`${hour}:00:00Z`)
  date.setUTCHours(date.getUTCHours() + delta)
  return usageHour(date)
}

/** Every bucket from the first day's start to the last day's end, at the resolution. */
function fullRange(resolution: Resolution, from: string, to: string): string[] {
  if (resolution === 'day') {
    return fullDayRange(from, to)
  }
  const hours: string[] = []
  const last = `${to}T23`
  for (let hour = `${from}T00`; hour <= last; hour = addHoursUTC(hour, 1)) {
    hours.push(hour)
  }
  return hours
}

// The bucket a turn falls in, as the axis key the chart is handed. `at time
// zone 'UTC'` comes first: date_trunc on a timestamptz would otherwise cut on
// the connection's zone, and `day` — the other key — is a UTC key.
function bucketOf(resolution: Resolution) {
  return resolution === 'day'
    ? chatUsageTurn.day
    : sql<string>`to_char(date_trunc('hour', ${chatUsageTurn.createdAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24')`
}

/**
 * The one date axis every series in the response shares (see SpaceUsageProps'
 * doc on why they must). A bounded period is zero-filled in full, even over
 * buckets with no rows; an open-ended custom bound — always day-bucketed, see
 * resolutionOf — falls back to the earliest/latest day actually recorded, so
 * an unbounded query does not walk to the start of time.
 */
function dateAxisOf(
  resolution: Resolution,
  range: { from?: string; to?: string },
  rows: { bucket: string }[],
): string[] {
  if (range.from && range.to) {
    return fullRange(resolution, range.from, range.to)
  }
  if (rows.length === 0) {
    return []
  }
  const days = rows.map((row) => row.bucket).sort()
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

// Within one read every bucket is the same width, so whatever a series is
// named, two different (series, bucket) pairs cannot produce the same key.
const cellKey = (seriesKey: string, bucket: string) => `${seriesKey}|${bucket}`

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
 * Both reads GROUP BY the full (bucket, agent, model) triple in SQL,
 * regardless of `grouping` — the database sums the counters instead of every
 * matching turn/model row crossing the wire. The bucket is a UTC day or, for
 * a short window, a UTC hour (see resolutionOf). The result set stays one row
 * per triple actually recorded (not one per turn), so the JS below still does
 * the grouping-dependent work: ranking groups, folding the tail into "Other",
 * building the date axis and padding cells — unchanged, just fed rows that
 * are already summed instead of raw ones.
 */
export async function queryChatUsage(
  spaceId: string,
  grouping: UsageGrouping,
  period: UsagePeriod,
): Promise<SpaceUsageSeries[]> {
  const range = dayRangeOf(period)
  const where = turnWhereOf(spaceId, range)
  const resolution = resolutionOf(range)
  const bucket = bucketOf(resolution)

  // Nothing links the two reads, so they go out together.
  const [tokenRows, costRows] = await Promise.all([
    db
      .select({
        bucket,
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
      .groupBy(bucket, chatUsageTurn.agent, chatUsageTurnModel.model),
    db
      .select({
        bucket,
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
      .groupBy(bucket, chatUsageTurn.agent, chatUsageTurn.model),
  ])

  const dates = dateAxisOf(resolution, range, tokenRows)
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

  // One cell per (series, bucket). Tokens and cost are summed over two
  // different row sets (see the function doc on why cost cannot share the
  // model rows' grouping) into the SAME cell map.
  const cells = new Map<string, UsageCell>()
  const cellOf = (row: { bucket: string; agent: string | null; model: string | null }): UsageCell => {
    const key = cellKey(seriesKeyOf(groupKeyOf(grouping, row.agent, row.model)), row.bucket)
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
 * Deletes every turn the space recorded in the period — the Usage page's
 * reset, and the one write this module makes that is not a recording. Same
 * scope as the read, so another space's turns and unattributed ones stay. The
 * turn's model rows go with it (the foreign key cascades), so a model-grouped
 * read afterwards has nothing orphaned to sum.
 *
 * Only a BOUNDED period is accepted. The read tolerates a half-picked custom
 * range by leaving that end open; a delete that did the same would wipe to
 * the start (or end) of time on a choice the reader had not finished making.
 * Returns how many turns went.
 */
export async function deleteChatUsage(spaceId: string, period: UsagePeriod): Promise<number> {
  const range = dayRangeOf(period)
  if (!range.from || !range.to) {
    throw new Error('A usage reset needs both ends of its period')
  }
  const removed = await db.delete(chatUsageTurn).where(turnWhereOf(spaceId, range)).returning({ id: chatUsageTurn.id })
  return removed.length
}
