import { chatUsageTurn, chatUsageTurnModel, db, space } from '@opencroft/db'
import type { UsageTokens } from 'agent-chat/components/usage-cost'
import type { SessionCost, TurnQuota, TurnTokenUsage } from 'agent-client/types'
import { and, count, eq, gte, inArray, lt, lte, sql, sum } from 'drizzle-orm'
import type {
  SpaceUsageGroup,
  SpaceUsageOption,
  SpaceUsagePoint,
  SpaceUsageSeries,
  UsageGrouping,
  UsagePeriod,
} from 'ui/admin/space-usage'

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
 * The recorded spend of some sessions, summed per (session key, UTC day,
 * cost currency): the cells a usage summary regroups. A cell's `currency` is
 * null for its unpriced turns, whose `costAmount` is then null too; a turn
 * with an amount and no currency counts as unpriced, as in
 * `queryChatUsageTurnsBySessionKey`.
 */
export interface ChatUsageCell {
  sessionKey: string
  day: string
  currency: string | null
  turns: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  costAmount: number | null
}

/**
 * The cells of the turns of `sessionKeys` that ended at or after `since` and
 * before `until`, and, given `spaceId`, were recorded in that space. Tokens are
 * each turn's whole spend, subagents included (see turnTokens).
 */
export async function queryChatUsageCells(input: {
  sessionKeys: readonly string[]
  since: Date
  until?: Date
  spaceId?: string
}): Promise<ChatUsageCell[]> {
  if (input.sessionKeys.length === 0) {
    return []
  }
  const tokens = turnTokens()
  const currency = sql<
    string | null
  >`case when ${chatUsageTurn.costAmount} is null then null else ${chatUsageTurn.costCurrency} end`
  const rows = await db
    .select({
      sessionKey: chatUsageTurn.sessionKey,
      day: chatUsageTurn.day,
      currency,
      turns: count().mapWith(Number),
      input: sum(tokens.input).mapWith(Number),
      output: sum(tokens.output).mapWith(Number),
      cacheRead: sum(tokens.cacheRead).mapWith(Number),
      cacheWrite: sum(tokens.cacheWrite).mapWith(Number),
      total: sum(tokens.total).mapWith(Number),
      // Undecoded: NULL for the unpriced group, a driver string otherwise.
      costAmount: sum(chatUsageTurn.costAmount),
    })
    .from(chatUsageTurn)
    .innerJoin(tokens, eq(tokens.turnId, chatUsageTurn.id))
    .where(
      and(
        inArray(chatUsageTurn.sessionKey, [...input.sessionKeys]),
        gte(chatUsageTurn.createdAt, input.since),
        input.until ? lt(chatUsageTurn.createdAt, input.until) : undefined,
        input.spaceId ? eq(chatUsageTurn.spaceId, input.spaceId) : undefined,
      ),
    )
    .groupBy(chatUsageTurn.sessionKey, chatUsageTurn.day, currency)
  return rows.flatMap((row) =>
    row.sessionKey === null
      ? []
      : [
          {
            sessionKey: row.sessionKey,
            day: row.day,
            currency: row.currency,
            turns: row.turns,
            tokens: {
              input: row.input,
              output: row.output,
              cacheRead: row.cacheRead,
              cacheWrite: row.cacheWrite,
              total: row.total,
            },
            costAmount: row.currency === null || row.costAmount === null ? null : Number(row.costAmount),
          },
        ],
  )
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
// Two scopes over one read. A space's read covers the turns whose `spaceId`
// was recorded as it (see recordChatUsageTurn): a turn no space's chat held is
// in no space's read, and no space's reset removes it. The instance's read
// covers every turn, so its totals are every space's plus those in none.

const ALL_SERIES_KEY = 'all'
const UNKNOWN_GROUP_KEY = '__unknown__'
const OTHER_SERIES_KEY = '__other__'
// With nothing chosen a page draws its five largest groups and folds the
// tail into one "Other" series, so a long tail is neither a tangle of lines
// nor dropped silently. Chosen groups are never folded (see readChatUsage).
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

/**
 * The space, when there is one, and the bounds as one turn-table predicate —
 * a space's read and its reset select the same rows by construction. Without
 * a space it is the instance's read, which the reset never takes (see
 * deleteChatUsage).
 */
function turnWhereOf(spaceId: string | undefined, range: { from?: string; to?: string }) {
  return and(
    spaceId === undefined ? undefined : eq(chatUsageTurn.spaceId, spaceId),
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

/** What a summed row is grouped by: the turn's agent and space, and the model it is counted on. */
interface GroupedRow {
  agent: string | null
  model: string | null
  spaceId: string | null
}

/**
 * The series a row belongs to, before any overflow folding. A space is keyed
 * by its id and named from `spaceNames`, the spaces that exist; a turn of a
 * deleted space keeps that space's id but is in no existing space's read, so
 * it counts with the turns recorded in none.
 */
function groupKeyOf(grouping: UsageGrouping, row: GroupedRow, spaceNames: ReadonlyMap<string, string>): string {
  switch (grouping) {
    case 'all':
      return ALL_SERIES_KEY
    case 'agent':
      return row.agent ?? UNKNOWN_GROUP_KEY
    case 'model':
      return row.model ?? UNKNOWN_GROUP_KEY
    case 'space':
      return row.spaceId !== null && spaceNames.has(row.spaceId) ? row.spaceId : UNKNOWN_GROUP_KEY
  }
}

// Within one read every bucket is the same width, so whatever a series is
// named, two different (series, bucket) pairs cannot produce the same key.
const cellKey = (seriesKey: string, bucket: string) => `${seriesKey}|${bucket}`

const UNKNOWN_GROUP_LABELS: Record<Exclude<UsageGrouping, 'all'>, string> = {
  agent: 'Direct chats',
  model: 'Unknown model',
  space: 'No space',
}

function labelOf(grouping: UsageGrouping, key: string, spaceNames: ReadonlyMap<string, string>): string {
  if (key === OTHER_SERIES_KEY) {
    return 'Other'
  }
  if (key === ALL_SERIES_KEY) {
    return 'All'
  }
  if (grouping !== 'all' && key === UNKNOWN_GROUP_KEY) {
    return UNKNOWN_GROUP_LABELS[grouping]
  }
  return grouping === 'space' ? (spaceNames.get(key) ?? key) : key
}

/**
 * The groups that get a series of their own, from a ranking: the first
 * MAX_SERIES, the rest folding into Other. Per space, the turns in no space
 * are never folded: the instance's totals are the spaces' plus theirs, and a
 * reader checking that sum needs their figure on its own.
 */
function keptOf(grouping: UsageGrouping, ranking: readonly string[]): string[] {
  const kept = ranking.slice(0, MAX_SERIES)
  if (grouping !== 'space' || kept.includes(UNKNOWN_GROUP_KEY) || !ranking.includes(UNKNOWN_GROUP_KEY)) {
    return kept
  }
  return [...ranking.slice(0, MAX_SERIES - 1), UNKNOWN_GROUP_KEY]
}

/** The names of the spaces that exist, by id: what the per-space grouping names its series by. */
async function spaceNamesById(): Promise<Map<string, string>> {
  const rows = await db.select({ id: space.id, name: space.name }).from(space)
  return new Map(rows.map((row) => [row.id, row.name]))
}

/**
 * Aggregate ChatUsageTurnModel (joined to its turn for day/agent/space) into the
 * SpaceUsage chart's series shape: one series for `all`, one per agent,
 * model or space otherwise, every series padded to the same date axis (see
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
 * Both reads GROUP BY the full (bucket, agent, space, model) tuple in SQL,
 * regardless of `grouping` — the database sums the counters instead of every
 * matching turn/model row crossing the wire. The bucket is a UTC day or, for
 * a short window, a UTC hour (see resolutionOf). The result set stays one row
 * per tuple actually recorded (not one per turn), so the JS below still does
 * the grouping-dependent work: ranking groups, folding the tail into "Other",
 * building the date axis and padding cells — unchanged, just fed rows that
 * are already summed instead of raw ones.
 *
 * `chosen` names groups of `grouping` by their series keys (see groupKeyOf):
 * only those groups' rows count, and each chosen group with turns in the
 * period is a series of its own, none folded into "Other". So a chosen
 * group's figures equal its row in `groups` with nothing chosen, and the
 * page's totals are the chosen groups' sum. Empty, and always under `all`,
 * every group counts. The choice is applied to the summed rows after both
 * reads, so the answer's `options` (every group with token rows in the
 * period, what the reader picks from) and the date axis of an open-ended
 * range come from the whole period, whatever is chosen.
 *
 * `groups` is every group the series were made from, folded or not, with its
 * figures over the whole period, largest first by the period's tokens (the
 * ranking the series are cut from, so a pinned No space row sits at its own
 * rank, not where its series is drawn): the page's list of
 * each group's spend. Empty for `all`, whose one group is the page's totals.
 */
export function queryChatUsage(
  spaceId: string,
  grouping: UsageGrouping,
  period: UsagePeriod,
  chosen: readonly string[] = [],
): Promise<ChatUsageAnswer> {
  return readChatUsage(spaceId, grouping, period, chosen)
}

/**
 * The same read as queryChatUsage over every turn the instance recorded, in
 * whatever space or none: the Administration page's Usage. Its `space`
 * grouping has a series per space and one for the turns in no space.
 */
export function queryInstanceChatUsage(
  grouping: UsageGrouping,
  period: UsagePeriod,
  chosen: readonly string[] = [],
): Promise<ChatUsageAnswer> {
  return readChatUsage(undefined, grouping, period, chosen)
}

/** What a Usage page asks for: the reader's grouping, period and the groups chosen in that grouping. */
export interface ChatUsageQuery {
  grouping: UsageGrouping
  period: UsagePeriod
  /** Series keys of `grouping` to draw; empty draws every group. */
  chosen: string[]
}

/** A usage read's answer: SpaceUsage's series, the groups the reader may choose from, and each group's figures. */
export interface ChatUsageAnswer {
  series: SpaceUsageSeries[]
  options: SpaceUsageOption[]
  groups: SpaceUsageGroup[]
}

async function readChatUsage(
  spaceId: string | undefined,
  grouping: UsageGrouping,
  period: UsagePeriod,
  chosen: readonly string[],
): Promise<ChatUsageAnswer> {
  const range = dayRangeOf(period)
  const where = turnWhereOf(spaceId, range)
  const resolution = resolutionOf(range)
  const bucket = bucketOf(resolution)

  // Nothing links the reads, so they go out together. The names are read only
  // when the grouping names its series by them.
  const [tokenRows, costRows, spaceNames] = await Promise.all([
    db
      .select({
        bucket,
        agent: chatUsageTurn.agent,
        spaceId: chatUsageTurn.spaceId,
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
      .groupBy(bucket, chatUsageTurn.agent, chatUsageTurn.spaceId, chatUsageTurnModel.model),
    db
      .select({
        bucket,
        agent: chatUsageTurn.agent,
        spaceId: chatUsageTurn.spaceId,
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
      .groupBy(bucket, chatUsageTurn.agent, chatUsageTurn.spaceId, chatUsageTurn.model),
    grouping === 'space' ? spaceNamesById() : new Map<string, string>(),
  ])

  const dates = dateAxisOf(resolution, range, tokenRows)
  if (dates.length === 0) {
    return { series: [], options: [], groups: [] }
  }

  const groupOf = (row: GroupedRow) => groupKeyOf(grouping, row, spaceNames)

  // Rank groups by total tokens over the whole period. With nothing chosen
  // the first MAX_SERIES (see keptOf) are drawn and the tail folds into one
  // "Other" series rather than being dropped. Chosen groups are drawn each as
  // its own, none folded, in the period's order, and a chosen group with no
  // turns in the period has no series. With a choice there is no "Other", so
  // an unchosen group's rows reach no series and every figure is the chosen
  // groups'.
  const totalsByGroup = new Map<string, number>()
  for (const row of tokenRows) {
    const group = groupOf(row)
    totalsByGroup.set(group, (totalsByGroup.get(group) ?? 0) + row.totalTokens)
  }
  const periodRanking = [...totalsByGroup.entries()].sort((a, b) => b[1] - a[1]).map(([group]) => group)
  const periodKept = keptOf(grouping, periodRanking)
  const chosenSet = new Set(grouping === 'all' ? [] : chosen)
  const choosing = chosenSet.size > 0
  const ranked = choosing ? periodRanking.filter((group) => chosenSet.has(group)) : periodRanking
  const kept = choosing ? ranked : periodKept
  const keptSet = new Set(kept)
  const seriesKeys = ranked.length > kept.length ? [...kept, OTHER_SERIES_KEY] : kept
  const seriesKeyOf = (group: string) => (keptSet.has(group) ? group : OTHER_SERIES_KEY)
  // Colour slots, distinct per series. A group with a series of its own when
  // nothing is chosen keeps that slot whatever is chosen, so choosing never
  // repaints it. Any other group takes the lowest slot no kept series holds.
  // Slots are never shared; past the chart's palette SpaceUsage cycles its
  // colours. "Other" and the groups folded into it have no slot: they are
  // marked folded, which SpaceUsage draws in its neutral.
  const periodSlot = new Map(periodKept.map((group, index) => [group, index]))
  const slots = new Map<string, number>()
  for (const group of kept) {
    const own = periodSlot.get(group)
    if (own !== undefined) {
      slots.set(group, own)
    }
  }
  const held = new Set(slots.values())
  let free = 0
  for (const group of kept.filter((group) => !slots.has(group))) {
    while (held.has(free)) {
      free++
    }
    slots.set(group, free)
    held.add(free)
  }
  const colorOf = (seriesKey: string) =>
    seriesKey === OTHER_SERIES_KEY ? { folded: true } : { colorIndex: slots.get(seriesKey) }

  // One cell per (series, bucket), and one per group over the whole period.
  // Tokens and cost are summed over two different row sets (see the function
  // doc on why cost cannot share the model rows' grouping) into the SAME
  // cells.
  const cells = new Map<string, UsageCell>()
  const groupCells = new Map<string, UsageCell>()
  const cellIn = (map: Map<string, UsageCell>, key: string): UsageCell => {
    let cell = map.get(key)
    if (!cell) {
      cell = emptyCell()
      map.set(key, cell)
    }
    return cell
  }
  const cellsOf = (row: GroupedRow & { bucket: string }): UsageCell[] => {
    const group = groupOf(row)
    return [cellIn(cells, cellKey(seriesKeyOf(group), row.bucket)), cellIn(groupCells, group)]
  }
  for (const row of tokenRows) {
    for (const cell of cellsOf(row)) {
      cell.inputTokens += row.inputTokens
      cell.outputTokens += row.outputTokens
      cell.cacheReadTokens += row.cacheReadTokens
      cell.cacheWriteTokens += row.cacheWriteTokens
      cell.totalTokens += row.totalTokens
    }
  }
  for (const row of costRows) {
    if (row.costAmount === null) {
      continue
    }
    for (const cell of cellsOf(row)) {
      cell.cost = (cell.cost ?? 0) + Number(row.costAmount)
    }
  }

  return {
    series: seriesKeys.map((seriesKey) => ({
      key: seriesKey,
      label: labelOf(grouping, seriesKey, spaceNames),
      ...colorOf(seriesKey),
      points: dates.map((date) => ({ date, ...(cells.get(cellKey(seriesKey, date)) ?? emptyCell()) })),
    })),
    // What the reader may choose from: every group the period has, whatever
    // is chosen, by name.
    options:
      grouping === 'all'
        ? []
        : periodRanking
            .map((key) => ({ key, label: labelOf(grouping, key, spaceNames) }))
            .sort((a, b) => a.label.localeCompare(b.label)),
    // The groups the series were made from, each with its cell. A folded
    // group is drawn in the "Other" line, so it wears that line's neutral.
    groups:
      grouping === 'all'
        ? []
        : ranked.map((group) => ({
            key: group,
            label: labelOf(grouping, group, spaceNames),
            ...colorOf(seriesKeyOf(group)),
            ...(groupCells.get(group) ?? emptyCell()),
          })),
  }
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
