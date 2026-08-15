/** One (day, agent, model) bucket of billed-equivalent usage, summed from Claude Code transcripts. */
export interface RollupRow {
  /** ISO date, 'YYYY-MM-DD', UTC -- sliced directly from each transcript message's UTC timestamp. */
  day: string
  agent: string
  model: string
  requests: number
  rawInputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  /** Requests whose cache write alone exceeded COLD_PRIME_THRESHOLD_TOKENS. */
  coldPrimeRequests: number
  coldPrimeTokens: number
}
