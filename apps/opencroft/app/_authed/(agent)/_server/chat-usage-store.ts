import { chatUsageTurn, db } from '@opencroft/db'
import type { SessionCost, TurnTokenUsage } from 'agent-client/types'

// Per-turn usage accounting for agent-chat sessions, read off the turn_end
// event the engine emits. One row per turn that reported a spend; the table's
// schema comment carries the reasoning for keeping these rows OUT of
// UsageRollupDay, and this module is the only writer.
//
// Not every harness prices sessions or names the model it ran, and a harness
// may report only the total — every optional input degrades to null/zero
// rather than the row being dropped: the total is the figure the day's
// accounting keys on, and a turn that ran is a turn that ran.

/** UTC date of the turn's end — the same 'YYYY-MM-DD' bucket UsageRollupDay uses. */
export function usageDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10)
}

export async function recordChatUsageTurn(input: {
  sessionId: string
  adapterId?: string
  model?: string
  at?: Date
  usage: TurnTokenUsage
  cost?: SessionCost
}): Promise<void> {
  await db.insert(chatUsageTurn).values({
    day: usageDay(input.at),
    sessionId: input.sessionId,
    adapterId: input.adapterId ?? 'unknown',
    model: input.model ?? null,
    inputTokens: input.usage.inputTokens ?? 0,
    outputTokens: input.usage.outputTokens ?? 0,
    cacheReadTokens: input.usage.cacheReadTokens ?? 0,
    cacheWriteTokens: input.usage.cacheWriteTokens ?? 0,
    totalTokens: input.usage.totalTokens,
    costAmount: input.cost?.amount ?? null,
    costCurrency: input.cost?.currency ?? null,
  })
}
