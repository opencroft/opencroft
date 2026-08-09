import type { CanonicalModeId } from 'agent-client/session-modes'
import { Compass, type LucideIcon, ShieldCheck, ShieldEllipsis, ShieldOff, ShieldQuestion, ShieldX } from 'lucide-react'

// Presentation for the canonical permission modes (agent-client/session-modes
// owns the classification itself; this is the half that has to know about an
// icon set).
//
// Five of the six are shield variants, because they answer one question — who
// decides, and what happens when nobody is asked — and reading them as a family
// is the point:
//
//   ShieldQuestion  manual        the shield asks you
//   ShieldEllipsis  auto          something else answers, request by request
//   ShieldCheck     accept-edits  edits are waved through, the rest still asked
//   ShieldX         dont-ask      stops asking and DENIES
//   ShieldOff       bypass        there is no shield left
//
// ShieldX vs ShieldOff carries the distinction that matters most here: both
// stop asking, and they are opposites in what the silence means.
//
// `plan` is the odd one out on purpose. It is not a stance on approving things,
// it is a stance on doing them at all, so it gets a compass rather than a
// shield — charting a course, executing nothing.
//
// Colours run inert → neutral → caution → gone, so the selector reads as a
// gradient. `auto` steps out of that ramp (violet): it is not "more permissive
// than accept-edits" so much as a different kind of thing — judgement handed to
// a classifier. `bypass` is the only destructive colour, shared with the YOLO
// badge, since YOLO forces exactly this mode.
export interface ModePresentation {
  icon: LucideIcon
  /** Tailwind text colour for the icon. */
  className: string
}

export const MODE_PRESENTATION: Record<CanonicalModeId, ModePresentation> = {
  plan: { icon: Compass, className: 'text-sky-500' },
  manual: { icon: ShieldQuestion, className: 'text-muted-foreground' },
  'accept-edits': { icon: ShieldCheck, className: 'text-amber-500' },
  auto: { icon: ShieldEllipsis, className: 'text-violet-500' },
  'dont-ask': { icon: ShieldX, className: 'text-orange-500' },
  bypass: { icon: ShieldOff, className: 'text-destructive' },
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
