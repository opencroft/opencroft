'use client'

import { Zap, ZapOff } from 'lucide-react'
import { Button } from 'ui/components/ui/button'

export interface FastModeToggleProps {
  enabled: boolean
  onToggle: (next: boolean) => void
  /** The agent's own words for what this setting is, and — when it is
   *  unavailable — why. Shown on hover. */
  description?: string
  /** When set, the control is inert and this is the reason, shown on hover. */
  lockedReason?: string
  className?: string
}

/**
 * An agent's fast mode as one icon button, sitting beside the reasoning effort
 * it trades against.
 *
 * A toggle rather than a menu: there are two states and no third, so a dropdown
 * would cost a press to say what the icon already says.
 *
 * It stays pressable even when the agent cannot honour it. Availability is per
 * model and the agent reports it as prose, not as a flag, so the honest
 * rendering is a toggle that may snap back with the reason on hover — rather
 * than an inert control guessing at a disabled state the wire never states.
 *
 * Whether this renders at all is the caller's decision. Fast mode is something
 * an agent advertises; one that does not offer it has no such state.
 */
export function FastModeToggle({ enabled, onToggle, description, lockedReason, className }: FastModeToggleProps) {
  const title = lockedReason ?? description ?? (enabled ? 'Fast mode on' : 'Fast mode off')

  return (
    <Button
      type='button'
      size='icon'
      variant='ghost'
      disabled={Boolean(lockedReason)}
      className={className ?? 'size-7 shrink-0'}
      // Without this the composer loses focus the moment this is clicked.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onToggle(!enabled)}
      title={title}
      aria-label={title}
      aria-pressed={enabled}
    >
      {enabled ? <Zap className='size-4 text-amber-500' /> : <ZapOff className='size-4 text-muted-foreground' />}
    </Button>
  )
}
