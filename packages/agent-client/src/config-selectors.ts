// Which config option carries which meaning.
//
// ACP marks an option's meaning with `category`, and every bridge measured so
// far sends one, but the spec is explicit that the field is "UX only", MUST
// NOT be required for correctness, and that clients MUST handle a missing or
// unknown one gracefully. So a conventional id is the fallback. Category is
// tried first because it is the protocol's own statement of meaning, where an
// id is a name two unrelated options could both pick — and two agents that
// mean the same thing routinely pick different ones: Claude Code's `effort`
// is codex-acp's `reasoning_effort`, Claude Code's `fast` is codex-acp's
// `fast-mode`.
//
// Pure and host-agnostic: the engine uses these to apply a profile's model and
// effort, and a chat surface uses the same ones to decide which option gets
// which control, so the two can never disagree about what "the effort option"
// is.

import type { SessionConfigOption } from '@agentclientprotocol/sdk'

export interface ConfigSelector {
  category: string
  id: string
  /**
   * Narrows a category that holds more than one meaning. `model_config` is
   * the spec's bucket for any per-model setting, so the category alone cannot
   * say which of them is fast mode.
   */
  accepts?: (option: SessionConfigOption) => boolean
  /** Wire shapes this meaning may arrive in. Defaults to select only. */
  types?: readonly SessionConfigOption['type'][]
}

export const MODE_SELECTOR: ConfigSelector = { category: 'mode', id: 'mode' }
export const MODEL_SELECTOR: ConfigSelector = { category: 'model', id: 'model' }
export const THOUGHT_LEVEL_SELECTOR: ConfigSelector = { category: 'thought_level', id: 'effort' }

// Fast mode is a per-model setting, so an agent that categorizes it at all
// files it under `model_config` (codex-acp 1.13.1, src/FastModeConfig.ts);
// among that category it is the option that names itself fast. Delivered as a
// native boolean where the client supports one and as an on/off select
// otherwise, so both shapes qualify.
const FAST = /\bfast\b/i
export const FAST_MODE_SELECTOR: ConfigSelector = {
  category: 'model_config',
  id: 'fast',
  accepts: (option) => FAST.test(option.id) || FAST.test(option.name),
  types: ['select', 'boolean'],
}

/** The option carrying the selector's meaning, category first, then id. */
export function findConfigOption(
  options: readonly SessionConfigOption[] | undefined,
  selector: ConfigSelector,
): SessionConfigOption | undefined {
  const types = selector.types ?? ['select']
  const candidates = (options ?? []).filter((entry) => types.includes(entry.type))
  return (
    candidates.find((entry) => entry.category === selector.category && (selector.accepts?.(entry) ?? true)) ??
    candidates.find((entry) => entry.id === selector.id)
  )
}

/** As findConfigOption, narrowed to the select shape. */
export function findSelectOption(options: readonly SessionConfigOption[] | undefined, selector: ConfigSelector) {
  const hit = findConfigOption(options, { ...selector, types: ['select'] })
  return hit?.type === 'select' ? hit : undefined
}
