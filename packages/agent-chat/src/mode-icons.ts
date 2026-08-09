import type { CanonicalModeId } from 'agent-client/session-modes'
import {
  type LucideIcon,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  ShieldCog,
  ShieldEllipsis,
  ShieldMinus,
  ShieldQuestion,
} from 'lucide-react'

// Presentation for the canonical permission modes (agent-client/session-modes
// owns the classification; this is the half that knows about an icon set).
//
// Every mode is a shield variant: they all answer one question — who decides,
// and what happens when nobody is asked — and reading them as a family is the
// point. The glyph carries the behaviour and the colour carries the severity,
// so the button is legible at a glance without reading the label.
//
// Colours run green → primary → amber → orange → destructive. Only `primary`
// and `destructive` exist as kit tokens, so the two middle steps use palette
// utilities; `auto` sits off the ramp in violet because delegated judgement is
// a different kind of thing, not a severity level.
export interface ModePresentation {
  icon: LucideIcon
  /** Tailwind text colour for the icon. */
  className: string
}

export const MODE_PRESENTATION: Record<CanonicalModeId, ModePresentation> = {
  auto: { icon: ShieldEllipsis, className: 'text-violet-500' },
  plan: { icon: ShieldQuestion, className: 'text-green-500' },
  'manual-edits': { icon: ShieldCheck, className: 'text-primary' },
  'accept-edits': { icon: ShieldCog, className: 'text-amber-500' },
  'reject-edits': { icon: ShieldMinus, className: 'text-orange-500' },
  bypass: { icon: ShieldBan, className: 'text-destructive' },
}

/**
 * How the mode button renders while a host has the control pinned to bypass —
 * the YOLO case. A steady ban icon reads as "this is the mode"; the point here
 * is that the gate is off and it was not this session's choice, so it alerts
 * and pulses instead. Kept next to the table it overrides so the two cannot
 * drift apart.
 */
export const BYPASS_FORCED_PRESENTATION: ModePresentation = {
  icon: ShieldAlert,
  className: 'text-destructive animate-pulse',
}

/**
 * Presentation for a mode, or undefined when the agent advertised something no
 * canonical id covers. Undefined is a normal answer: render the agent's own
 * name without an icon rather than inventing one, which would assert a
 * behaviour nobody has verified.
 */
export function modePresentation(canonical: CanonicalModeId | undefined): ModePresentation | undefined {
  return canonical ? MODE_PRESENTATION[canonical] : undefined
}
