/**
 * `@opencroft/server/usage` — what the agents' sessions in group-chat threads
 * have spent, summed: tokens and cost, never a transcript.
 */

/**
 * Which threads a summary sums: those of the chats in a space (its slug), of
 * one chat (its id or slug), or addressed to one agent (its node id). Only
 * ever among the threads of the chats the reader is a member of.
 */
export type HostUsageScope = { space: string } | { chat: string } | { agent: string }

/**
 * What one summary row sums over: an agent (`key` is its node id), a thread
 * (its `ref`), a chat (its `ref`) or a UTC day (`YYYY-MM-DD`).
 */
export type HostUsageGroupBy = 'agent' | 'thread' | 'chat' | 'day'

export interface HostUsageSummaryOptions {
  scope: HostUsageScope
  /** ISO time: turns that ended at or after it. */
  since: string
  /** ISO time: turns that ended before it; open when left out. */
  until?: string
  groupBy: HostUsageGroupBy
}

/** The spend of one group in a summary. */
export interface HostUsageSummaryRow {
  key: string
  /** The turns' whole token spend, what their subagents spent included. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  /**
   * The summed cost of the row's priced turns. Null when none of them is
   * priced (a harness that does not price its sessions), or when they are
   * priced in more than one currency: never a sum made up of what was not
   * reported.
   */
  cost: { amount: number; currency: string } | null
  /** How many of the row's turns carried a cost; `cost` covers these alone. */
  pricedTurns: number
  /** How many finished turns the row sums. */
  turns: number
}

/**
 * Spend summaries, read as ONE reader the host chose. Here, the extension's
 * own system identity, so only the chats a person granted it into. Inside an
 * App action (`ctx.usage`): the calling agent's chats when an agent called,
 * the calling person's when a signed-in person did, and the system
 * identity's otherwise.
 */
export interface HostUsageApi {
  /**
   * The spend in `scope` between `since` and `until`, one row per group with
   * at least one turn: by `day` oldest first, otherwise most tokens first.
   * An archived thread counts; a deleted one does not.
   * For a `space` scope only spend made while the thread's chat was that
   * space's counts. A `chat` the reader is not in refuses with "Not
   * available"; a space or agent with nothing the reader may see answers
   * an empty list.
   */
  summary(options: HostUsageSummaryOptions): Promise<HostUsageSummaryRow[]>
}

/** Spend summaries as this extension's own system identity — see `HostUsageApi`. */
export declare const usage: HostUsageApi
