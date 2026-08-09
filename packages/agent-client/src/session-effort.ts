// A fixed vocabulary for reasoning effort, the sibling of session-modes.ts.
//
// Same problem, same shape of answer: agents advertise effort levels as
// free-form `{name, value}` pairs, so a UI has nothing stable to hang an icon,
// a colour or an ordering off. This classifies them without replacing them —
// an unrecognised level still renders with the agent's own name.
//
// One difference from modes, and it matters for how much to trust this file:
// the Claude Code bridge does NOT carry a fixed list. It title-cases whatever
// `ModelInfo.supportedEffortLevels` reports at runtime and prepends `default`,
// so the set varies by model and cannot be read off the source the way
// buildAvailableModes() could. The generic normaliser below is therefore the
// main mechanism rather than a fallback, and anything it misses degrades to
// "shown with the agent's own name, no icon" rather than to a wrong icon.

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

// Wire spellings that resolve for any adapter. Keys are already normalised
// (lowercased, separators stripped). `xhigh` is the one worth noting: Claude
// Code surfaces it as "Xhigh", which is not a word — the canonical label
// "Extra" is exactly the kind of thing this vocabulary exists to fix.
const GENERIC_EFFORT_IDS: Record<string, CanonicalEffortId> = {
  default: 'default',
  none: 'default',
  off: 'default',
  low: 'low',
  medium: 'medium',
  med: 'medium',
  high: 'high',
  xhigh: 'extra',
  extrahigh: 'extra',
  extra: 'extra',
  max: 'max',
  maximum: 'max',
}

/**
 * Per-adapter overrides, keyed by adapter id then by the wire value. Empty
 * today: every level currently observed resolves through the generic table.
 * It exists so a future agent that reuses a common word for an uncommon level
 * can be corrected in one place, the same way ADAPTER_MODE_IDS works.
 */
const ADAPTER_EFFORT_IDS: Record<string, Record<string, CanonicalEffortId>> = {}

function normalizeEffortId(value: string): string {
  return value.toLowerCase().replace(/[-_\s]/g, '')
}

/**
 * Classify one agent-advertised effort value, or undefined when nothing
 * recognises it. Undefined is a normal answer: the level is still real and
 * selectable, it just renders with the agent's own name.
 */
export function canonicalEffortId(adapterId: string, value: string): CanonicalEffortId | undefined {
  return ADAPTER_EFFORT_IDS[adapterId]?.[value] ?? GENERIC_EFFORT_IDS[normalizeEffortId(value)]
}
