// Model discovery over an OpenAI-compatible `/models` endpoint.
//
// Lives here rather than beside a host's server actions because both the model
// picker and the in-process harness need it: the picker to list what can be
// selected, the harness to learn the context window it reports as the session's
// size. One fetch shape, one set of field names to keep current.

export interface OpenAiModel {
  id: string
  // The model's context window in tokens, when the endpoint reports one.
  // Absent means the endpoint said nothing — NOT that the window is small.
  contextWindow?: number
}

// The spellings OpenAI-compatible endpoints actually use for the window. The
// base OpenAI `/models` response carries no window at all, so every one of
// these is a vendor extension and the list grows by observation, not by guess.
// Read in order; the first usable number wins.
const WINDOW_FIELDS = [
  'context_length',
  'context_window',
  'max_context_length',
  'max_model_len',
  'max_input_tokens',
] as const

// A window is only believed when it is a positive whole number. A zero, a
// negative, a float or a string is treated as "not reported" rather than
// coerced — the engine already renders an unknown window honestly, and a
// wrong-but-plausible number is worse than none: it understates capacity and
// can trigger a compaction the session did not need.
function readWindow(entry: Record<string, unknown>): number | undefined {
  for (const field of WINDOW_FIELDS) {
    const value = entry[field]
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value
    }
  }
  return undefined
}

// Discovery is on the path of a session start, so it is bounded: an endpoint
// that never answers leaves the facts unknown rather than holding the session.
const DISCOVERY_TIMEOUT_MS = 8000

export async function listOpenAiModels(baseUrl: string, apiKey?: string): Promise<OpenAiModel[]> {
  const base = baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  const response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  const body = (await response.json()) as { data?: unknown[] }
  const models: OpenAiModel[] = []
  for (const entry of body.data ?? []) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const record = entry as Record<string, unknown>
    // An entry with no usable id names nothing and cannot be selected.
    if (typeof record.id !== 'string' || record.id.length === 0) {
      continue
    }
    models.push({ id: record.id, contextWindow: readWindow(record) })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

// What the endpoint says about itself, or [] when it says nothing (or cannot be
// reached). Never throws: discovery being unavailable means the facts are
// unknown, not that the caller's work should fail.
export async function discoverModels(baseUrl: string, apiKey?: string): Promise<OpenAiModel[]> {
  try {
    return await listOpenAiModels(baseUrl, apiKey)
  } catch {
    return []
  }
}
