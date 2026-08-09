'use client'

import { canonicalModeId } from 'agent-client/session-modes'
import { Button } from 'ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'

import { modePresentation } from './mode-icons'

export interface ModeSelectorOption {
  /** The agent's own wire id for the mode. */
  value: string
  /** The agent's own display name. */
  label: string
}

export interface ModeSelectorProps {
  options: ModeSelectorOption[]
  current: string
  onSelect: (value: string) => void
  /**
   * Adapter the session runs, used to classify the modes (see
   * agent-client/session-modes). Without it only the obvious spellings resolve,
   * so a mode whose wire id does not describe it — Claude Code's `default`,
   * which means "Manual" — renders with its name but no icon. Correct, just
   * less legible.
   */
  adapterId?: string
  /** When set, the control is inert and this is the reason, shown on hover. */
  lockedReason?: string
}

/**
 * The session's permission mode as an icon button rather than a labelled
 * dropdown among the other config options.
 *
 * It is pulled out of that row deliberately: the mode is the one setting that
 * changes what the agent is allowed to DO, and it reads better as a single
 * glanceable icon — the colour alone says how much is being waved through —
 * than as one more select whose current value you have to read.
 *
 * Falls back to the agent's own name whenever a mode is unclassified, and
 * renders nothing at all when the session advertises no modes.
 */
export function ModeSelector({ options, current, onSelect, adapterId, lockedReason }: ModeSelectorProps) {
  if (options.length === 0) {
    return null
  }
  const canonicalFor = (value: string) => (adapterId ? canonicalModeId(adapterId, value) : undefined)
  const currentOption = options.find((option) => option.value === current)
  const currentPresentation = modePresentation(canonicalFor(current))
  const CurrentIcon = currentPresentation?.icon
  const currentLabel = currentOption?.label ?? current
  const title = lockedReason ?? `Permission mode: ${currentLabel}`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={Boolean(lockedReason)}>
        <Button variant='ghost' size='icon' className='size-7' title={title} aria-label={title}>
          {CurrentIcon ? (
            <CurrentIcon className={`size-4 ${currentPresentation.className}`} />
          ) : (
            // No icon for an unclassified mode rather than a stand-in that would
            // assert a behaviour nobody has verified — its initial still
            // identifies it.
            <span className='text-xs font-medium'>{currentLabel.slice(0, 1).toUpperCase()}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        {options.map((option) => {
          const presentation = modePresentation(canonicalFor(option.value))
          const Icon = presentation?.icon
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onSelect(option.value)}
              className={option.value === current ? 'font-medium' : undefined}
            >
              {Icon ? <Icon className={`size-4 ${presentation.className}`} /> : <span className='size-4' />}
              {option.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
