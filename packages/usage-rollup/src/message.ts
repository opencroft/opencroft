import { COLD_PRIME_THRESHOLD_TOKENS } from './rollup-script'
import type { RollupRow } from './types'

function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(1)}B`
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`
  }
  return String(Math.round(n))
}

// GLM-path sessions run on a separate, uncached provider outside the
// Max-subscription weekly limit — reported as their own line rather than
// folded into the cached-provider table.
function isGlmModel(model: string): boolean {
  return model.toLowerCase().startsWith('glm')
}

interface AgentTotals {
  agent: string
  requests: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

function sumByAgent(rows: RollupRow[]): AgentTotals[] {
  const byAgent = new Map<string, AgentTotals>()
  for (const row of rows) {
    let totals = byAgent.get(row.agent)
    if (!totals) {
      totals = { agent: row.agent, requests: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
      byAgent.set(row.agent, totals)
    }
    totals.requests += row.requests
    totals.cacheReadTokens += row.cacheReadTokens
    totals.cacheWriteTokens += row.cacheWriteTokens
    totals.outputTokens += row.outputTokens
  }
  return Array.from(byAgent.values()).sort((a, b) => b.requests - a.requests)
}

function sumOf(rows: { requests: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }[]) {
  return rows.reduce(
    (acc, r) => ({
      requests: acc.requests + r.requests,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
    }),
    { requests: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  )
}

/** Formats one day's already-aggregated rows into the chat message text. Pure — no I/O. */
export function composeDailyRollupMessage(day: string, rows: RollupRow[]): string {
  if (rows.length === 0) {
    return `Usage rollup — ${day}: no transcript activity found.`
  }

  const cachedRows = rows.filter((r) => !isGlmModel(r.model))
  const glmRows = rows.filter((r) => isGlmModel(r.model))
  const lines: string[] = [`Usage rollup — ${day}`, '']

  if (cachedRows.length > 0) {
    const agentTotals = sumByAgent(cachedRows)
    lines.push('| Agent | Requests | Cache read | Cache write | Output |')
    lines.push('|---|---|---|---|---|')
    for (const totals of agentTotals) {
      lines.push(
        `| ${totals.agent} | ${formatCount(totals.requests)} | ${formatTokens(totals.cacheReadTokens)} | ${formatTokens(totals.cacheWriteTokens)} | ${formatTokens(totals.outputTokens)} |`,
      )
    }
    const total = sumOf(agentTotals)
    lines.push(
      `| **Total** | **${formatCount(total.requests)}** | **${formatTokens(total.cacheReadTokens)}** | **${formatTokens(total.cacheWriteTokens)}** | **${formatTokens(total.outputTokens)}** |`,
    )
  }

  if (glmRows.length > 0) {
    const glmRequests = glmRows.reduce((sum, r) => sum + r.requests, 0)
    const glmRawInput = glmRows.reduce((sum, r) => sum + r.rawInputTokens, 0)
    lines.push('')
    lines.push(
      `GLM (separate provider, no caching): ${formatCount(glmRequests)} requests, ${formatTokens(glmRawInput)} raw input`,
    )
  }

  const coldPrimeRequests = rows.reduce((sum, r) => sum + r.coldPrimeRequests, 0)
  const coldPrimeTokens = rows.reduce((sum, r) => sum + r.coldPrimeTokens, 0)
  if (coldPrimeRequests > 0) {
    lines.push('')
    lines.push(
      `Cold re-primes (cache write > ${formatTokens(COLD_PRIME_THRESHOLD_TOKENS)}): ${formatCount(coldPrimeRequests)} requests, ${formatTokens(coldPrimeTokens)} tokens`,
    )
  }

  return lines.join('\n')
}
