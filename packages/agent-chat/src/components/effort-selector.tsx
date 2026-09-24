'use client'

import { Lightbulb, LightbulbOff } from 'lucide-react'
import { Button } from 'ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'

// How hard an agent is asked to think.
//
// The whole vocabulary this component knows. Callers pass the levels an agent
// offers; where those came from, and how they were arrived at, is none of this
// component's business.
export type Effort = 'max' | 'extra' | 'high' | 'medium' | 'low' | 'default' | 'off'

// Anything that is not one of ours is shown as its own label, in the neutral
// colour. `string & {}` keeps autocomplete for the known grades while still
// accepting one.
export type EffortOption = Effort | (string & {})

// One glyph throughout, unlike the permission modes: effort is a single dial,
// so the grade is the colour and a different icon per step would imply six
// different things rather than six settings of one.
//
// `default` is the neutral foreground rather than a literal white, which would
// disappear on a light theme while reading as white in dark mode as intended.
const EFFORT_COLOR = {
  max: 'text-blue-500',
  extra: 'text-purple-500',
  high: 'text-red-500',
  medium: 'text-yellow-500',
  low: 'text-green-500',
  default: 'text-foreground',
  off: 'text-foreground',
}

const EFFORT_LABEL = {
  max: 'Max',
  extra: 'Extra',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  default: 'Default',
  off: 'Off',
}

// Strongest first: the heavier grades are the ones reached deliberately, so
// they sit a short travel from the top of the menu rather than at the far end.
const EFFORT_ORDER: Effort[] = ['max', 'extra', 'high', 'medium', 'low', 'default', 'off']

function isKnown(option: EffortOption): option is Effort {
  return (EFFORT_ORDER as string[]).includes(option)
}

function orderOf(option: EffortOption): number {
  return isKnown(option) ? EFFORT_ORDER.indexOf(option) : Number.MAX_SAFE_INTEGER
}

function labelOf(option: EffortOption): string {
  return isKnown(option) ? EFFORT_LABEL[option] : option
}

function colourOf(option: EffortOption): string {
  return isKnown(option) ? EFFORT_COLOR[option] : 'text-muted-foreground'
}

// `off` is not a grade on the dial — it is an instruction not to think — so it
// is the one level drawn with a different glyph.
function EffortIcon({ option }: { option: EffortOption }) {
  const className = `size-4 ${colourOf(option)}`
  return option === 'off' ? <LightbulbOff className={className} /> : <Lightbulb className={className} />
}

export interface EffortSelectorProps {
  /** The levels on offer. Order does not matter; the menu sorts them. */
  options: EffortOption[]
  current: EffortOption
  onSelect: (option: EffortOption) => void
  /** When set, the control is inert and this is the reason, shown on hover. */
  lockedReason?: string
  className?: string
}

/**
 * Reasoning effort as one icon button, matching the permission-mode control it
 * sits beside.
 *
 * Renders nothing when there are no levels: what an agent offers depends on the
 * model, and an empty dial would imply a setting that does not exist for this
 * one.
 */
export function EffortSelector({ options, current, onSelect, lockedReason, className }: EffortSelectorProps) {
  if (options.length === 0) {
    return null
  }
  const title = lockedReason ?? `Reasoning effort: ${labelOf(current)}`
  const ordered = [...options].sort((a, b) => orderOf(a) - orderOf(b))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={Boolean(lockedReason)}
        render={
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className={className ?? 'size-7 shrink-0'}
            // Without this the composer loses focus the moment this is clicked.
            onMouseDown={(e) => e.preventDefault()}
            title={title}
            aria-label={title}
          />
        }
      >
        <EffortIcon option={current} />
      </DropdownMenuTrigger>
      {/* The bar this sits in is at the bottom of the screen, so its menus open
          upward from the start edge. */}
      <DropdownMenuContent align='start' side='top'>
        {ordered.map((option) => (
          <DropdownMenuItem
            key={option}
            onClick={() => onSelect(option)}
            className={option === current ? 'font-medium' : undefined}
          >
            <EffortIcon option={option} />
            {labelOf(option)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
