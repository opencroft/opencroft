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

export type CanonicalEffortId = 'default' | 'off' | 'low' | 'medium' | 'high' | 'extra' | 'max'

export interface CanonicalEffortInfo {
  id: CanonicalEffortId
  /** Display label, replacing whatever the agent called it. */
  label: string
  /** Menu order. Strongest first, so the heavier grades are the short reach
   *  from the top of the menu rather than the far end of it. */
  order: number
}

export const CANONICAL_EFFORTS: Record<CanonicalEffortId, CanonicalEffortInfo> = {
  max: { id: 'max', label: 'Max', order: 0 },
  extra: { id: 'extra', label: 'Extra', order: 1 },
  high: { id: 'high', label: 'High', order: 2 },
  medium: { id: 'medium', label: 'Medium', order: 3 },
  low: { id: 'low', label: 'Low', order: 4 },
  default: { id: 'default', label: 'Default', order: 5 },
  off: { id: 'off', label: 'Off', order: 6 },
}

const EFFORT_IDS = Object.keys(CANONICAL_EFFORTS) as CanonicalEffortId[]

/**
 * Spellings that mean one of ours, for any agent.
 *
 * `xhigh` is the one that earns this file: Claude Code surfaces it as "Xhigh",
 * which is not a word — our "Extra" is exactly what a shared vocabulary is for.
 *
 * `none` maps to `off` rather than to `default`: they are different answers.
 * `off` is an instruction not to think; `default` is "do not tune this", and
 * leaves whatever baseline the agent already has. An agent that means the
 * baseline by `none` overrides this per adapter, which is what the per-adapter
 * layer of the registry is for.
 */
const SHARED_EFFORT_SYNONYMS = {
  off: ['none'],
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
