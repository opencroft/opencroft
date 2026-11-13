// Spend summaries for extensions: the recorded turns of the threads a reader
// may see, regrouped by agent, thread, chat or day. Numbers only; nothing of a
// transcript is read. Which threads count is decided here from the reader's
// chats; what they spent comes from the usage store.

import type {
  HostUsageGroupBy,
  HostUsageScope,
  HostUsageSummaryOptions,
  HostUsageSummaryRow,
} from '@opencroft/server/usage'

import { type ChatUsageCell, queryChatUsageCells } from '@/app/_authed/(agent)/_server/chat-usage-store'
import { type MemberPrincipal, type SenderThread, threadsForReader } from '@/app/_authed/(group-chats)/_server/model'
import { spaceIdBySlug } from '@/app/_authed/(group-chats)/_server/thread-space'

const GROUPINGS: readonly HostUsageGroupBy[] = ['agent', 'thread', 'chat', 'day']
const SCOPE_KEYS = ['space', 'chat', 'agent'] as const

function scopeOf(scope: unknown): HostUsageScope {
  const refused = new Error('"scope" must name exactly one of "space", "chat" or "agent", as a non-empty string')
  if (typeof scope !== 'object' || scope === null) {
    throw refused
  }
  const named = SCOPE_KEYS.filter((key) => Object.hasOwn(scope, key))
  if (named.length !== 1 || Object.keys(scope).length !== 1) {
    throw refused
  }
  const [key] = named
  const value = (scope as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw refused
  }
  return { [key]: value.trim() } as HostUsageScope
}

function timeOf(name: string, value: unknown): Date {
  const at = typeof value === 'string' ? new Date(value) : new Date(Number.NaN)
  if (Number.isNaN(at.getTime())) {
    throw new Error(`"${name}" must be an ISO date; got ${JSON.stringify(value)}`)
  }
  return at
}

function groupingOf(groupBy: unknown): HostUsageGroupBy {
  if (!GROUPINGS.includes(groupBy as HostUsageGroupBy)) {
    throw new Error(`"groupBy" must be one of ${GROUPINGS.join(', ')}; got ${JSON.stringify(groupBy)}`)
  }
  return groupBy as HostUsageGroupBy
}

function groupKey(groupBy: HostUsageGroupBy, thread: SenderThread, cell: ChatUsageCell): string {
  switch (groupBy) {
    case 'agent':
      return thread.agent.nodeId
    case 'thread':
      return thread.ref
    case 'chat':
      return thread.chat.ref
    case 'day':
      return cell.day
  }
}

/** A row mid-sum: its tokens and turns, and its priced turns' amounts by currency. */
interface Accumulator {
  row: HostUsageSummaryRow
  amountByCurrency: Map<string, number>
}

function emptyAccumulator(key: string): Accumulator {
  return {
    row: {
      key,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: null,
      pricedTurns: 0,
      turns: 0,
    },
    amountByCurrency: new Map(),
  }
}

function add(into: Accumulator, cell: ChatUsageCell): void {
  const { row } = into
  row.turns += cell.turns
  row.tokens.input += cell.tokens.input
  row.tokens.output += cell.tokens.output
  row.tokens.cacheRead += cell.tokens.cacheRead
  row.tokens.cacheWrite += cell.tokens.cacheWrite
  row.tokens.total += cell.tokens.total
  if (cell.currency !== null && cell.costAmount !== null) {
    row.pricedTurns += cell.turns
    into.amountByCurrency.set(cell.currency, (into.amountByCurrency.get(cell.currency) ?? 0) + cell.costAmount)
  }
}

/** The row with its cost: one currency's sum, or null when no turn was priced or several currencies were. */
function finished({ row, amountByCurrency }: Accumulator): HostUsageSummaryRow {
  const [only] = amountByCurrency
  return amountByCurrency.size === 1 ? { ...row, cost: { amount: only[1], currency: only[0] } } : row
}

function compareRows(groupBy: HostUsageGroupBy) {
  return (a: HostUsageSummaryRow, b: HostUsageSummaryRow): number => {
    if (groupBy !== 'day' && a.tokens.total !== b.tokens.total) {
      return b.tokens.total - a.tokens.total
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  }
}

/**
 * The spend of the threads `reader` may see in `options.scope`, grouped as
 * asked. Archived threads count; a deleted thread's turns have no thread left
 * to be seen through, so they do not.
 */
export async function usageSummary(
  reader: MemberPrincipal,
  options: HostUsageSummaryOptions,
): Promise<HostUsageSummaryRow[]> {
  if (typeof options !== 'object' || options === null) {
    throw new Error('usage.summary takes { scope, since, until?, groupBy }')
  }
  const scope = scopeOf(options.scope)
  const groupBy = groupingOf(options.groupBy)
  const since = timeOf('since', options.since)
  const until = options.until === undefined ? undefined : timeOf('until', options.until)

  let spaceId: string | undefined
  if ('space' in scope) {
    const found = await spaceIdBySlug(scope.space)
    if (!found) {
      return []
    }
    spaceId = found
  }
  const threads = (
    await threadsForReader(reader, { chat: 'chat' in scope ? scope.chat : undefined, includeArchived: true })
  ).filter(({ thread }) => !('agent' in scope) || thread.agent.nodeId === scope.agent)
  const threadByKey = new Map(threads.map(({ thread, sessionKey }) => [sessionKey, thread] as const))

  const cells = await queryChatUsageCells({ sessionKeys: [...threadByKey.keys()], since, until, spaceId })
  const groups = new Map<string, Accumulator>()
  for (const cell of cells) {
    const thread = threadByKey.get(cell.sessionKey)
    if (!thread) {
      continue
    }
    const key = groupKey(groupBy, thread, cell)
    let group = groups.get(key)
    if (!group) {
      group = emptyAccumulator(key)
      groups.set(key, group)
    }
    add(group, cell)
  }
  return [...groups.values()].map(finished).sort(compareRows(groupBy))
}
