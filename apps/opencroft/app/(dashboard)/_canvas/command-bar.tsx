'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import { ScrollArea } from 'ui/scroll-area'
import { NodeCard } from '@/app/(dashboard)/_canvas/node-card'
import { cn } from '@/lib/utils'

interface CommandBarProps {
  accent?: string
  children: ReactNode
  className?: string
}

export function CommandBar({ accent = 'var(--primary)', children, className }: CommandBarProps) {
  return (
    <NodeCard accent={accent} selected className={cn('pointer-events-auto', className)}>
      <div className='flex items-start gap-2 px-2 py-1.5'>{children}</div>
    </NodeCard>
  )
}

interface CommandBarMenuProps {
  accent?: string
  children: ReactNode
  className?: string
}

export function CommandBarMenu({ accent = 'var(--primary)', children, className }: CommandBarMenuProps) {
  return (
    <NodeCard accent={accent} selected className={cn('overflow-hidden', 'pointer-events-auto', className)}>
      <ScrollArea className='[&>[data-slot=scroll-area-viewport]]:max-h-80'>
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
