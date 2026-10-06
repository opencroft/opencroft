'use client'

// CommandBar used to be its own copy of the card a composer sits in -- now
// re-exported straight from the kit's CommandBarFrame (ui/agent-chat/command-bar-frame),
// which reproduces it exactly. That copy was exactly how the group-chat
// composers ended up looking unlike the 1:1 command bar: neither was drawing
// from the same definition. The re-export (rather than deleting the name)
// keeps this module's public shape -- it is also re-exported through the
// extension host API in _client/host.ts, which extensions import by name.
// CommandBarMenu/CommandBarMenuItem below have no kit equivalent and stay
// app-side.

import { cn } from 'cn'
import { type ReactNode, useEffect, useRef } from 'react'
import { CommandBarFrame } from 'ui/agent-chat/command-bar-frame'
import { ScrollArea } from 'ui/layout/scroll-area'

import { NodeCard } from '@/app/_authed/(dashboard)/_canvas/node-card'

export { CommandBarFrame as CommandBar }

interface CommandBarMenuProps {
  accent?: string
  children: ReactNode
  className?: string
}

export function CommandBarMenu({ accent = 'var(--primary)', children, className }: CommandBarMenuProps) {
  return (
    <NodeCard
      accent={accent}
      selected
      tinted={false}
      className={cn('overflow-hidden', 'pointer-events-auto', className)}
    >
      <ScrollArea viewportClassName='max-h-80'>
        <ul className='py-1'>{children}</ul>
      </ScrollArea>
    </NodeCard>
  )
}

interface CommandBarMenuItemProps {
  active: boolean
  onSelect: () => void
  onHover?: () => void
  children: ReactNode
  className?: string
}

export function CommandBarMenuItem({ active, onSelect, onHover, children, className }: CommandBarMenuItemProps) {
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [active])

  return (
    <li>
      <button
        ref={ref}
        type='button'
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={onHover}
        onClick={onSelect}
        className={cn('w-full flex flex-col gap-0.5 px-3 py-1.5 text-left', active && 'bg-accent', className)}
      >
        {children}
      </button>
    </li>
  )
}
