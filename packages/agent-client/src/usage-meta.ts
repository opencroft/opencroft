// Wire-side parsers for the usage/limit metadata that rides OUTSIDE the
// fields ACP types: `_meta` keys some harnesses attach to `usage_update` and
// the prompt response, and the response's own experimental `usage`. None of
// it is guaranteed by the spec, so every reader here takes `unknown` and
// answers `undefined` for anything that does not match — a harness that
// sends garbage loses the decoration, never the turn.
//
// One module because the shapes share a home: they all describe what a turn
// or an account spent, and a host reading them should not have to know which
// `_meta` namespace each one arrived under.

import type { RateLimitWindow, SessionFailure, TurnQuota, TurnTokenUsage } from './types'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The claude bridge forwards the SDK's rate-limit events on the
 * `_claude/rateLimit` key of a `usage_update`'s `_meta`. Its shape is the
 * SDK's `rate_limit_info`: one verdict per event, naming the window it
 * concerns (`five_hour`, `seven_day`, `seven_day_opus`, …).
 */
export function parseRateLimit(meta: unknown): RateLimitWindow | undefined {
  const record = asRecord(meta)
  const info = asRecord(record?.['_claude/rateLimit'])
  if (!info) {
    return undefined
  }
  const status = nonEmptyString(info.status)
  const window = nonEmptyString(info.rateLimitType)
  if (!status || !window) {
    return undefined
  }
  const utilization = finiteNumber(info.utilization)
  const resetsAt = normalizeResetsAt(info.resetsAt)
  return {
    status,
    window,
    ...(utilization !== undefined ? { utilization } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }
}

/**
 * The SDK documents `resetsAt` as a number without pinning the unit (epoch
 * seconds and milliseconds both appear across CLI versions). Every plausible
 * epoch-second value is below 1e11 — early in the year 5138 in ms — and every
 * plausible epoch-ms value is above it, so the magnitude decides. A value
 * that fits neither reading is dropped rather than shown as a nonsense date.
 */
export function normalizeResetsAt(value: unknown): number | undefined {
  const n = finiteNumber(value)
  if (n === undefined || n <= 0) {
    return undefined
  }
  if (n < 1e11) {
    return Math.round(n * 1000)
  }
  return Math.round(n)
}

/**
 * Merge one window's fresh reading into the session's list: keyed by window
 * name, so a `five_hour` update never disturbs a stored `seven_day` one, and
 * a window the harness stops reporting keeps its last known state.
 */
export function mergeRateLimit(list: RateLimitWindow[] | undefined, next: RateLimitWindow): RateLimitWindow[] {
  const rest = (list ?? []).filter((entry) => entry.window !== next.window)
  return [...rest, next].sort((a, b) => a.window.localeCompare(b.window))
}

/**
 * A prompt turn's token spend, off the response's experimental `usage`. Only
 * `totalTokens` is required by the wire type; counters the harness omitted
 * stay absent so a host never reads an invented zero as a measurement.
 */
export function normalizeTurnUsage(usage: unknown): TurnTokenUsage | undefined {
  const record = asRecord(usage)
  if (!record) {
    return undefined
  }
  const totalTokens = finiteNumber(record.totalTokens)
  if (totalTokens === undefined) {
    return undefined
  }
  // Counters the harness omitted stay out of the object entirely: an absent
  // field and an undefined one deep-equal differently, and the absence is
  // the honest spelling of "not reported".
  return {
    totalTokens,
    ...(finiteNumber(record.inputTokens) !== undefined ? { inputTokens: finiteNumber(record.inputTokens) } : {}),
    ...(finiteNumber(record.outputTokens) !== undefined ? { outputTokens: finiteNumber(record.outputTokens) } : {}),
    ...(finiteNumber(record.thoughtTokens) !== undefined ? { thoughtTokens: finiteNumber(record.thoughtTokens) } : {}),
    ...(finiteNumber(record.cacheReadTokens) !== undefined
      ? { cacheReadTokens: finiteNumber(record.cacheReadTokens) }
      : {}),
    ...(finiteNumber(record.cacheWriteTokens) !== undefined
      ? { cacheWriteTokens: finiteNumber(record.cacheWriteTokens) }
      : {}),
  }
}

/**
 * The claude bridge's `_meta.quota`: the turn's main-loop token count plus a
 * per-model breakdown that also counts subagents and internal calls. The
 * breakdown is decorated, not authoritative — a malformed row is dropped,
 * and a missing one leaves `modelUsage` absent rather than empty.
 */
export function parseTurnQuota(meta: unknown): TurnQuota | undefined {
  const record = asRecord(meta)
  const quota = asRecord(record?.quota)
  if (!quota) {
    return undefined
  }
  const tokenCount = normalizeTurnUsage(quota.token_count)
  if (!tokenCount) {
    return undefined
  }
  const rows = Array.isArray(quota.model_usage) ? quota.model_usage : []
  const modelUsage = rows
    .map((row) => {
      const entry = asRecord(row)
      const model = nonEmptyString(entry?.model)
      const count = entry ? normalizeTurnUsage(entry.token_count) : undefined
      return model && count ? { model, tokenCount: count } : undefined
    })
    .filter((row): row is { model: string; tokenCount: TurnTokenUsage } => row !== undefined)
  return modelUsage.length > 0 ? { tokenCount, modelUsage } : { tokenCount }
}

/**
 * A typed session failure, off the AIR `sessionFailure` extension the bridge
 * writes into `_meta` (turn-scoped on the prompt response, session-scoped on
 * a `session_info_update`). `title` and `kind` are what a host shows; the
 * rest is the harness's own structured verdict.
 */
export function parseSessionFailure(meta: unknown): SessionFailure | undefined {
  const record = asRecord(meta)
  const air = asRecord(record?.jetbrains)?.air
  const failure = asRecord(asRecord(air)?.sessionFailure)
  if (!failure) {
    return undefined
  }
  const id = nonEmptyString(failure.id)
  const kind = nonEmptyString(failure.kind)
  const title = nonEmptyString(failure.title)
  if (!id || !kind || !title) {
    return undefined
  }
  const details = nonEmptyString(failure.details)
  return {
    id,
    kind,
    title,
    category: nonEmptyString(failure.category) ?? 'unknown',
    severity: nonEmptyString(failure.severity) ?? 'error',
    ...(details ? { details } : {}),
    actions: Array.isArray(failure.actions)
      ? failure.actions.filter((action): action is string => typeof action === 'string')
      : undefined,
  }
}
