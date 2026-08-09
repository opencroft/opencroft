// Our vocabulary for reasoning effort, the sibling of session-modes.ts and
// built on the same synonym registry (see synonyms.ts).
//
// One difference from modes, and it matters for how much to trust this file:
// the Claude Code bridge carries no fixed list. It title-cases whatever
// `ModelInfo.supportedEffortLevels` reports at runtime and prepends `default`,
// so the set varies by model and cannot be read off its source the way
// buildAvailableModes() could. Synonym registration is therefore the whole
// mechanism here rather than a supplement to a verified table, and anything
// unregistered degrades to "shown with the agent's own name, no grade colour"
// rather than to a wrong grade.

import { createSynonymResolver } from './synonyms'

export type CanonicalEffortId = 'default' | 'low' | 'medium' | 'high' | 'extra' | 'max'

export interface CanonicalEffortInfo {
  id: CanonicalEffortId
  /** Display label, replacing whatever the agent called it. */
  label: string
  /** Menu order, ascending — here this IS the effort ramp. */
  order: number
}

export const CANONICAL_EFFORTS: Record<CanonicalEffortId, CanonicalEffortInfo> = {
  default: { id: 'default', label: 'Default', order: 0 },
  low: { id: 'low', label: 'Low', order: 1 },
  medium: { id: 'medium', label: 'Medium', order: 2 },
  high: { id: 'high', label: 'High', order: 3 },
  extra: { id: 'extra', label: 'Extra', order: 4 },
  max: { id: 'max', label: 'Max', order: 5 },
}

const EFFORT_IDS = Object.keys(CANONICAL_EFFORTS) as CanonicalEffortId[]

/**
 * Spellings that mean one of ours, for any agent.
 *
 * `xhigh` is the one that earns this file: Claude Code surfaces it as "Xhigh",
 * which is not a word — our "Extra" is exactly what a shared vocabulary is for.
 * `none`/`off` map to `default` because an agent that reports no reasoning and
 * one that reports its own baseline are the same choice from the user's side:
 * "do not tune this".
 */
const SHARED_EFFORT_SYNONYMS = {
  default: ['none', 'off'],
  extra: ['xhigh'],
}

const resolver = createSynonymResolver<CanonicalEffortId>(EFFORT_IDS, SHARED_EFFORT_SYNONYMS)

/**
 * Our id for an agent-advertised effort value, or undefined when nothing
 * recognises it. Undefined is a normal answer: the level is still real and
 * selectable, it just renders with the agent's own name.
 */
export function canonicalEffortId(adapterId: string, value: string): CanonicalEffortId | undefined {
  return resolver.resolve(adapterId, value)
}
