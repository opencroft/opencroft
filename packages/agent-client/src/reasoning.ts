// Client-safe: pure heuristics, no node:* imports.

// Best-effort detection of which reasoning-effort levels a model supports.
// The AI SDK / providers don't expose this, so it's keyed off model-name
// families. Returns [] when the model has no known reasoning support.
export function reasoningEfforts(model: string): string[] {
  const m = model.toLowerCase()
  // OpenAI reasoning models expose the full reasoning_effort scale.
  if (/gpt-5|gpt-oss|\bo[1-4]\b/.test(m)) {
    return ['minimal', 'low', 'medium', 'high']
  }
  // Other thinking-capable families (Claude, Gemini 2.5+, DeepSeek-R1, Qwen3,
  // GLM 4.6+, Grok 3/4) — expose a coarse low/medium/high.
  if (
    /claude|sonnet|opus|gemini-2\.5|gemini-3|deepseek-r1|deepseek.*think|qwen3|qwen.*think|glm-4\.[6-9]|glm-[5-9]|grok-[34]/.test(
      m,
    )
  ) {
    return ['low', 'medium', 'high']
  }
  return []
}
