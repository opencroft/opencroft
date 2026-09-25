// Client-safe: pure helper, no node:* imports.

// A plain string from any thrown value — an Error's message, or the value
// stringified when it isn't one (e.g. a thrown string/object).
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// A JSON-RPC error's three fields, read off whatever was thrown. By shape
// rather than by class: the ACP SDK's RequestError is one carrier of them, and
// a check against the class would miss the same fields on anything else.
export function rpcErrorParts(error: unknown): { code?: number; message: string; data?: unknown } {
  const fields = typeof error === 'object' && error !== null ? (error as { code?: unknown; data?: unknown }) : {}
  return {
    ...(typeof fields.code === 'number' ? { code: fields.code } : {}),
    message: errorMessage(error),
    ...(fields.data !== undefined && fields.data !== null ? { data: fields.data } : {}),
  }
}

// What a JSON-RPC error's `data` says in words, when it says anything.
//
// The message alone is often the generic half. The ACP SDK answers a plain
// throw inside an agent's handler with -32603 "Internal error" and puts the
// thrown message in `data.details`, so "Session not found" arrives as
// `Internal error` with the cause one level down. A string, a `details` or a
// `message` is taken as written; any other payload is shown as JSON, since a
// structured cause (an error kind, a failing field) still names what failed.
export function rpcErrorDetail(data: unknown): string | undefined {
  if (data === undefined || data === null) {
    return undefined
  }
  if (typeof data === 'string') {
    return data.trim() || undefined
  }
  if (typeof data === 'object') {
    const { details, message } = data as { details?: unknown; message?: unknown }
    for (const candidate of [details, message]) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim()
      }
    }
  }
  const json = safeJson(data)
  return json === '{}' || json === '[]' ? undefined : json
}

// JSON that never throws: a payload with a cycle or a bigint is still worth a
// line in a log, just not a crash of the path reporting it.
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// A refusal that asking again cannot change: the profile has no key, the
// account is not signed in, the adapter cannot carry what the profile needs.
// The same call gives the same answer until someone acts on the message, so a
// caller that retries on failure should stop on this one and show it instead
// -- retrying only repeats the work of getting here, which for a harness can
// mean spawning a process each time.
// Its message is written for the person who has to act on it.
export class ActionRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionRequiredError'
  }
}
