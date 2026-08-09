'use client'

import { CANONICAL_EFFORTS, type CanonicalEffortId, canonicalEffortId } from 'agent-client/session-effort'
import { Lightbulb } from 'lucide-react'
import { Button } from 'ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'

// Colour per grade. `default` is deliberately the neutral foreground rather
// than a literal white, which would vanish on a light theme — it reads as white
// in dark mode, which is the intent, and stays legible in both.
const EFFORT_COLOUR: Record<CanonicalEffortId, string> = {
  default: 'text-foreground',
  low: 'text-green-500',
  medium: 'text-yellow-500',
  high: 'text-red-500',
  extra: 'text-purple-500',
  max: 'text-blue-500',
}

export interface EffortSelectorOption {
  /** The agent's own wire value. */
  value: string
  /** The agent's own display name. */
  label: string
}

export interface EffortSelectorProps {
  options: EffortSelectorOption[]
  current: string
  onSelect: (value: string) => void
  /** Adapter the session runs, used to classify the levels (see session-effort). */
  adapterId?: string
  /** When set, the control is inert and this is the reason, shown on hover. */
  lockedReason?: string
}

/**
 * Reasoning effort as one icon button, matching the permission-mode control
 * beside it. One glyph throughout — effort is a single dial, so the grade is
 * carried by colour alone rather than by a different icon per step.
 *
 * Renders nothing when the session advertises no levels: effort is
 * model-dependent, and an empty dial would imply a setting that does not exist
 * for this model.
 */
export function EffortSelector({ options, current, onSelect, adapterId, lockedReason }: EffortSelectorProps) {
  if (options.length === 0) {
    return null
  }
  const canonicalFor = (value: string) => (adapterId ? canonicalEffortId(adapterId, value) : undefined)
  const currentCanonical = canonicalFor(current)
  const currentLabel =
    (currentCanonical && CANONICAL_EFFORTS[currentCanonical].label) ??
    options.find((option) => option.value === current)?.label ??
    current
  const colour = currentCanonical ? EFFORT_COLOUR[currentCanonical] : 'text-muted-foreground'
  const title = lockedReason ?? `Reasoning effort: ${currentLabel}`
  // Our ramp, not the agent's ordering; unclassified levels keep their relative
  // order and land after everything recognised.
  const ordered = [...options].sort((a, b) => {
    const ac = canonicalFor(a.value)
    const bc = canonicalFor(b.value)
    return (
      (ac ? CANONICAL_EFFORTS[ac].order : Number.MAX_SAFE_INTEGER) -
      (bc ? CANONICAL_EFFORTS[bc].order : Number.MAX_SAFE_INTEGER)
    )
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={Boolean(lockedReason)}>
        <Button variant='ghost' size='icon' className='size-7' title={title} aria-label={title}>
          <Lightbulb className={`size-4 ${colour}`} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        {ordered.map((option) => {
          const canonical = canonicalFor(option.value)
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onSelect(option.value)}
              className={option.value === current ? 'font-medium' : undefined}
            >
              <Lightbulb className={`size-4 ${canonical ? EFFORT_COLOUR[canonical] : 'text-muted-foreground'}`} />
              {(canonical && CANONICAL_EFFORTS[canonical].label) ?? option.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
