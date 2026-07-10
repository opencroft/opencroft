// Client-safe: pure helper, no node:* imports.

// A plain string from any thrown value — an Error's message, or the value
// stringified when it isn't one (e.g. a thrown string/object).
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
