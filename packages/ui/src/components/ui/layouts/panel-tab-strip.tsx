'use client'

import type { ComponentType } from 'react'

import { Separator } from 'ui/components/ui/separator'
import { cn } from 'ui/lib/utils'

export interface PanelTab {
  id: string
  label: string
  /** Optional leading icon. Any component taking a className -- a lucide icon,
   *  or whatever the host resolves an extension's icon name to. */
  icon?: ComponentType<{ className?: string }>
  /** Optional trailing count. Hidden when absent or zero, so a tab that has
   *  nothing pending is not distinguished from one that cannot count. */
  count?: number
}

export interface PanelTabStripProps {
  tabs: PanelTab[]
  /** The active tab's id. The caller owns it -- this strip holds no state. */
  activeId: string
  onSelect: (id: string) => void
  /** The rule beneath the strip. On by default: every panel that uses this has
   *  one, and it belongs to the strip rather than to whatever follows it. */
  separator?: boolean
  className?: string
}

// The tab strip at the top of a panel: an optional leading icon, a label, an
// optional count, and an underline under the active one.
//
// Controlled and presentation-only: the active id arrives as a prop and the
// choice leaves as a callback, so the strip never decides what is open.
//
// The row scrolls rather than wraps. A panel is the narrowest surface in the
// product and its tab count is set by whatever an extension publishes, so tabs
// will outrun the width; wrapping would silently change the panel's header
// height and push the content down.
export function PanelTabStrip({
  tabs,
  activeId,
  onSelect,
  separator = true,
  className,
}: PanelTabStripProps) {
  return (
    <>
      <div
        role='tablist'
        className={cn(
          'flex items-center gap-0 overflow-x-auto px-3 pt-2 pb-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          className,
        )}
      >
        {tabs.map((tab) => {
          const TabIcon = tab.icon
          const isActive = tab.id === activeId
          return (
            <button
              key={tab.id}
              type='button'
              role='tab'
              aria-selected={isActive}
              onClick={() => onSelect(tab.id)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors',
                isActive
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground/80',
              )}
            >
              {TabIcon ? <TabIcon className='size-3' /> : null}
              {tab.label}
              {tab.count ? (
                <span className='rounded-full bg-primary/15 px-1.5 text-[10px] text-primary'>{tab.count}</span>
              ) : null}
            </button>
          )
        })}
      </div>
      {separator ? <Separator /> : null}
    </>
  )
}
