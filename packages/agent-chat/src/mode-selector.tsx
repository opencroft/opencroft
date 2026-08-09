'use client'

import { CANONICAL_MODES, canonicalModeId } from 'agent-client/session-modes'
import { Button } from 'ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'

import { BYPASS_FORCED_PRESENTATION, modePresentation } from './mode-icons'

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
  const currentCanonical = canonicalFor(current)
  const currentOption = options.find((option) => option.value === current)
  // Canonical label when we recognise the mode, so the same behaviour reads the
  // same whichever agent is behind the chat; the agent's own wording otherwise.
  const currentLabel = (currentCanonical && CANONICAL_MODES[currentCanonical].label) ?? currentOption?.label ?? current
  // A pinned bypass is not this session's choice, so it alerts rather than
  // sitting there looking like a setting someone picked.
  const forcedBypass = Boolean(lockedReason) && currentCanonical === 'bypass'
  const currentPresentation = forcedBypass ? BYPASS_FORCED_PRESENTATION : modePresentation(currentCanonical)
  const CurrentIcon = currentPresentation?.icon
  const title = lockedReason ?? `Permission mode: ${currentLabel}`
  // Our order, not the agent's: the same mode should sit in the same place
  // whichever agent is behind the chat. Anything unclassified keeps its
  // relative order and lands after everything we recognise.
  const ordered = [...options].sort((a, b) => {
    const ac = canonicalFor(a.value)
    const bc = canonicalFor(b.value)
    return (
      (ac ? CANONICAL_MODES[ac].order : Number.MAX_SAFE_INTEGER) -
      (bc ? CANONICAL_MODES[bc].order : Number.MAX_SAFE_INTEGER)
    )
  })

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
        {ordered.map((option) => {
          const canonical = canonicalFor(option.value)
          const presentation = modePresentation(canonical)
          const Icon = presentation?.icon
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onSelect(option.value)}
              className={option.value === current ? 'font-medium' : undefined}
            >
              {Icon ? <Icon className={`size-4 ${presentation.className}`} /> : <span className='size-4' />}
              {(canonical && CANONICAL_MODES[canonical].label) ?? option.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
