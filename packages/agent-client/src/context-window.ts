// What context window to report for a model, when nothing authoritative says.
//
// Its own module so the decision can be tested without constructing a harness,
// and so the one place that guesses is the one place to replace when a real
// source of windows exists.

// Best-effort context window per model family. The AI SDK exposes none, so this
// is a guess from the model's NAME and nothing more.
//
// It cannot be made correct by editing it. One substring cannot tell a
// 200k-window model from a 1M-window one released under the same family name,
// and every entry goes stale the moment a provider ships a larger window —
// which is exactly how a session came to report three times more tokens held
// than the window it claimed to have. Treat the numbers as a hint, never as a
// fact about the session.
//
// The real fix is a configured per-model window; until there is one,
// `reportedContextWindow` at least refuses to state a guess the session has
// already disproven.
//
// Returns 0 for "unknown", which the engine surfaces as an undefined max.
export function contextWindow(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('claude')) return 200_000
  if (m.includes('gpt-5') || m.includes('o3') || m.includes('o4')) return 400_000
  if (m.includes('gpt-4')) return 128_000
  if (m.includes('gemini')) return 1_000_000
  if (m.includes('glm')) return 200_000
  if (m.includes('qwen')) return 256_000
  if (m.includes('deepseek')) return 128_000
  return 0
}

// The window to report alongside `used` — or 0, meaning unknown.
//
// A guessed window the conversation has ALREADY EXCEEDED is not a window: the
// session is holding more than it says fits, so the guess is disproven by the
// only evidence available. Reporting it anyway produces a pair that cannot be
// true, which reads as a broken meter and, worse, drives compaction decisions
// off a number that was never right. Unknown is the honest answer, and callers
// already distinguish it — an absent limit means "cannot compute a ratio", not
// "no capacity left".
//
// This deliberately WITHHOLDS the guess rather than stretching it to fit. Two
// reasons it must not clamp: a clamped limit would still assert a capacity
// nobody established, and `used` above a limit reported by a harness that
// genuinely knows its window is a real, alarming state — the next turn does not
// fit — which has to stay visible. Only guesses are withheld here; windows from
// a harness that knows one never pass through this.
export function reportedContextWindow(model: string, used: number): number {
  const guess = contextWindow(model)
  return guess > 0 && used > guess ? 0 : guess
}
