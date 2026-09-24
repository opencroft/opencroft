'use client'

import {
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  ShieldCog,
  ShieldEllipsis,
  ShieldMinus,
  ShieldQuestion,
} from 'lucide-react'
import { Button } from 'ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'

// What an agent is allowed to do without asking.
//
// The whole vocabulary this component knows. Callers pass the modes an agent
// offers; where those came from, and how they were arrived at, is none of this
// component's business.
export type PermissionMode = 'auto' | 'plan' | 'manual-edits' | 'accept-edits' | 'reject-edits' | 'bypass'

// Anything that is not one of ours is shown as its own label, without an icon.
// `string & {}` keeps autocomplete for the known modes while still accepting one.
export type ModeOption = PermissionMode | (string & {})

// Every mode is a shield variant so they read as one family: the glyph carries
// the behaviour, the colour carries the severity.
//
// ShieldMinus against ShieldBan is the distinction worth the most care — both
// stop asking, and they are opposites in what the silence means. Reject denies
// what was not pre-approved; Bypass permits everything.
const MODE_ICON = {
  auto: ShieldEllipsis,
  plan: ShieldQuestion,
  'manual-edits': ShieldCheck,
  'accept-edits': ShieldCog,
  'reject-edits': ShieldMinus,
  bypass: ShieldBan,
}

// Literal classes only — a constructed name would not survive the build.
const MODE_COLOR = {
  auto: 'text-violet-500',
  plan: 'text-primary',
  'manual-edits': 'text-green-500',
  'accept-edits': 'text-amber-500',
  'reject-edits': 'text-orange-500',
  bypass: 'text-destructive',
}

const MODE_LABEL = {
  auto: 'Auto',
  plan: 'Plan',
  'manual-edits': 'Manual Edits',
  'accept-edits': 'Accept Edits',
  'reject-edits': 'Reject Edits',
  bypass: 'Bypass Permissions',
}

// Menu order. Deliberately not a severity ramp — Auto leads while being far
// from the least permissive — so it is stated rather than derived.
const MODE_ORDER: PermissionMode[] = ['auto', 'plan', 'manual-edits', 'accept-edits', 'reject-edits', 'bypass']

function isKnown(option: ModeOption): option is PermissionMode {
  return (MODE_ORDER as string[]).includes(option)
}

function orderOf(option: ModeOption): number {
  // Anything unrecognised keeps its relative order and lands after the rest.
  return isKnown(option) ? MODE_ORDER.indexOf(option) : Number.MAX_SAFE_INTEGER
}

function labelOf(option: ModeOption): string {
  return isKnown(option) ? MODE_LABEL[option] : option
}

export interface ModeSelectorProps {
  /** The modes on offer. Order does not matter; the menu sorts them. */
  options: ModeOption[]
  current: ModeOption
  onSelect: (option: ModeOption) => void
  /** When set, the control is inert and this is the reason, shown on hover. */
  lockedReason?: string
  className?: string
}

/**
 * The session's permission mode as one icon button rather than a labelled
 * dropdown among other settings.
 *
 * It earns the separate treatment because it is the setting that changes what
 * the agent may DO, and as an icon the colour alone says how much is being
 * waved through.
 */
export function ModeSelector({ options, current, onSelect, lockedReason, className }: ModeSelectorProps) {
  if (options.length === 0) {
    return null
  }
  const locked = Boolean(lockedReason)
  // A pinned bypass is not this session's choice, so it alerts rather than
  // sitting there looking like a setting someone picked.
  const forcedBypass = locked && current === 'bypass'
  const Icon = forcedBypass ? ShieldAlert : isKnown(current) ? MODE_ICON[current] : undefined
  const colour = forcedBypass
    ? 'text-destructive animate-pulse'
    : isKnown(current)
      ? MODE_COLOR[current]
      : 'text-muted-foreground'
  const title = lockedReason ?? `Permission mode: ${labelOf(current)}`
  const ordered = [...options].sort((a, b) => orderOf(a) - orderOf(b))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={locked}
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
        {Icon ? (
          <Icon className={`size-4 ${colour}`} />
        ) : (
          <span className='text-xs font-medium'>{labelOf(current).slice(0, 1).toUpperCase()}</span>
        )}
      </DropdownMenuTrigger>
      {/* The bar this sits in is at the bottom of the screen, so its menus open
          upward from the start edge. */}
      <DropdownMenuContent align='start' side='top' className='w-auto max-w-(--available-width)'>
        {ordered.map((option) => {
          const ItemIcon = isKnown(option) ? MODE_ICON[option] : undefined
          return (
            <DropdownMenuItem
              key={option}
              onClick={() => onSelect(option)}
              className={option === current ? 'font-medium' : undefined}
            >
              {ItemIcon ? (
                <ItemIcon className={`size-4 ${MODE_COLOR[option as PermissionMode]}`} />
              ) : (
                <span className='size-4' />
              )}
              {labelOf(option)}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
