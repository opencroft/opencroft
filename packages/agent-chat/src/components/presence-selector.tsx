'use client'

import { Activity } from 'lucide-react'
import { useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { Input } from 'ui/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/components/ui/popover'
import { cn } from 'ui/lib/utils'

// How often an agent reads what has been sent to it.
//
// Declared here rather than imported from the package that also defines it: a
// type-only import still puts that package in this one's import graph and
// manifest, which is the layering this component exists on the right side of.
// The host's own copy satisfies this structurally.
export type PresenceValue =
  // Above realtime: not merely read as it arrives -- a running turn is
  // stopped to read it.
  | { kind: 'high-attention' }
  | { kind: 'realtime' }
  // Below realtime: read at the agent's own turn boundary, never mid-turn.
  | { kind: 'online' }
  | { kind: 'minutes' }
  | { kind: 'hourly' }
  | { kind: 'daily' }
  | { kind: 'custom'; intervalMs: number }

export type FixedPresenceKind = 'high-attention' | 'realtime' | 'online' | 'minutes' | 'hourly' | 'daily'

const MINUTE_MS = 60_000

// Literal classes only -- a constructed name would not survive the build.
//
// Five colours for seven cadences, deliberately. What the colour answers is
// "how does this cadence read", not "which setting is selected": red stops
// the turn to read now, violet streams into the live turn, green reads at
// its own next turn, blue reads later, amber reads on an interval somebody
// chose. Which of the three later cadences is in force is not a thing to
// read off a 16-pixel glyph, so it is on the button's title and in the
// popover, where an exact answer belongs.
const PRESENCE_COLOR = {
  'high-attention': 'text-red-500',
  realtime: 'text-violet-500',
  online: 'text-green-500',
  minutes: 'text-blue-500',
  hourly: 'text-blue-500',
  daily: 'text-blue-500',
  custom: 'text-amber-500',
}

// The cadences with nothing to configure, in the order they are offered:
// soonest first, so the list reads as one dial rather than as a set.
//
// Custom is not among them. It is the one that needs a number, which makes it a
// row with an input rather than another item to press.
const FIXED: { kind: FixedPresenceKind; label: string; hint: string }[] = [
  { kind: 'high-attention', label: 'High Attention', hint: 'interrupts to read' },
  { kind: 'realtime', label: 'Realtime', hint: 'as it arrives' },
  { kind: 'online', label: 'Online', hint: 'between its turns' },
  { kind: 'minutes', label: 'In minutes', hint: 'within a few' },
  { kind: 'hourly', label: 'Within the hour', hint: 'in 30–45 min' },
  { kind: 'daily', label: 'Daily', hint: 'once a day' },
]

// A custom interval is stored in milliseconds and read in minutes, and it is
// never shown as less than one: a sub-minute interval is realtime by another
// name, and rounding it to "0 minutes" would describe a cadence nobody can set.
function customMinutes(presence: PresenceValue): number {
  return presence.kind === 'custom' ? Math.max(1, Math.round(presence.intervalMs / MINUTE_MS)) : 0
}

// What the cadence is called, wherever it has to be said in words -- the
// button's title here, and whatever a host puts beside it. Exported so a host
// naming the same setting cannot word it differently.
export function presenceLabel(presence: PresenceValue): string {
  if (presence.kind === 'custom') {
    const minutes = customMinutes(presence)
    return `Every ${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  return FIXED.find((entry) => entry.kind === presence.kind)?.label ?? presence.kind
}

export interface PresenceSelectorProps {
  presence: PresenceValue
  onSelect: (presence: PresenceValue) => void
  // Whether this session's agent takes mid-turn input. Realtime is the one
  // cadence that only exists as a steering behaviour (streaming into the live
  // turn), so without steering it is not offered — on such an agent it would
  // behave exactly like Online under a different name. The CURRENT value is
  // still shown if it happens to be realtime; hiding is about not offering a
  // distinction the session cannot make, not about denying what is set.
  steering?: boolean
  className?: string
}

/**
 * The session's reading cadence as one icon button.
 *
 * A popover rather than a menu, because one of the choices is a number: a menu
 * closes on its first interaction, so an input inside one can never be typed
 * into. The popover stays open through the whole job, which is what makes it a
 * place a value can be entered and then applied.
 *
 * Every choice here is reached by a press, including the custom one -- there is
 * no hover-revealed control and nothing to drag, so the whole of it works on a
 * touch screen without a second route having to exist.
 */
export function PresenceSelector({ presence, onSelect, steering = true, className }: PresenceSelectorProps) {
  const current = customMinutes(presence)
  const [open, setOpen] = useState(false)
  const [minutes, setMinutes] = useState(current ? String(current) : '')
  const offered = steering ? FIXED : FIXED.filter((entry) => entry.kind !== 'realtime')

  // Reseeded on open rather than kept in sync: while the popover is shut the
  // typed value has no owner, and starting from what is actually in force is
  // what makes the input read as the current setting instead of as a leftover.
  const openChange = (next: boolean) => {
    if (next) {
      setMinutes(current ? String(current) : '')
    }
    setOpen(next)
  }

  const parsed = Number.parseInt(minutes, 10)
  const customValid = Number.isFinite(parsed) && parsed >= 1

  const applyCustom = () => {
    if (!customValid) {
      return
    }
    onSelect({ kind: 'custom', intervalMs: parsed * MINUTE_MS })
    setOpen(false)
  }

  const title = `Reads messages: ${presenceLabel(presence)}`

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger
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
        <Activity className={`size-4 ${PRESENCE_COLOR[presence.kind]}`} />
      </PopoverTrigger>
      {/* The bar this sits in is at the bottom of the screen, so its overlays
          open upward from the start edge. Dressed as the kit's menus are:
          a p-1 inset, flush rows, a full-width divider. */}
      <PopoverContent align='start' side='top' className='w-64 gap-0 p-1'>
        <div className='flex flex-col'>
          {offered.map((entry) => (
            <button
              key={entry.kind}
              type='button'
              onClick={() => {
                onSelect({ kind: entry.kind })
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-baseline justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent',
                presence.kind === entry.kind && 'bg-accent font-medium',
              )}
            >
              <span className='flex items-center gap-2'>
                <Activity className={`size-4 shrink-0 ${PRESENCE_COLOR[entry.kind]}`} />
                {entry.label}
              </span>
              <span className='shrink-0 text-xs text-muted-foreground'>{entry.hint}</span>
            </button>
          ))}
        </div>
        <div className='-mx-1 my-1 h-px bg-border' />
        <div className={cn('flex items-center gap-2 px-2 py-1', presence.kind === 'custom' && 'font-medium')}>
          <Activity className={`size-4 shrink-0 ${PRESENCE_COLOR.custom}`} />
          <span className='text-sm'>Every</span>
          <Input
            type='number'
            min={1}
            inputMode='numeric'
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                applyCustom()
              }
            }}
            className='h-7 min-w-0 flex-1'
            aria-label='Custom reading interval, in minutes'
          />
          <span className='text-sm text-muted-foreground'>min</span>
          <Button
            type='button'
            size='sm'
            variant='secondary'
            className='h-7'
            disabled={!customValid}
            onClick={applyCustom}
          >
            Set
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
