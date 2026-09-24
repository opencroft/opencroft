'use client'

import { Brain } from 'lucide-react'
import { Button } from 'ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'

// One choice on offer: the wire value an agent expects back, and the label to
// show for it. Unlike effort/mode, models have no small closed vocabulary this
// component could know in advance -- the agent names them, this only displays
// what it's given.
export interface ModelOption {
  value: string
  label: string
}

export interface ModelSelectorProps {
  /** The models on offer, in the order the agent advertised them. */
  options: ModelOption[]
  current: string
  onSelect: (value: string) => void
  /** When set, the control is inert and this is the reason, shown on hover. */
  lockedReason?: string
  className?: string
}

/**
 * The session's model as one icon button, matching the Effort/Permission
 * controls it sits beside. Unlike those, a model carries no grade or severity
 * to color by -- one glyph, uncolored, throughout.
 *
 * Renders nothing when there are no models on offer.
 */
export function ModelSelector({ options, current, onSelect, lockedReason, className }: ModelSelectorProps) {
  if (options.length === 0) {
    return null
  }
  const currentLabel = options.find((option) => option.value === current)?.label ?? current
  const title = lockedReason ?? `Model: ${currentLabel}`

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
        <Brain className='size-4' />
      </DropdownMenuTrigger>
      {/* The bar this sits in is at the bottom of the screen, so its menus open
          upward from the start edge. */}
      <DropdownMenuContent align='start' side='top'>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onSelect(option.value)}
            className={option.value === current ? 'font-medium' : undefined}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
