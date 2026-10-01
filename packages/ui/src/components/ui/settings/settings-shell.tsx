'use client'

import type React from 'react'

import { MenuLayout } from '../layout/menulayout'
import { ScrollContent, ScrollPage } from '../layout/scrollpage'
import { cn } from 'cn'

export interface SettingsSection {
  id: string
  label: string
  // The host resolves the section's icon to a component; this only renders
  // it. Omitted means the entry stands on its label alone.
  icon?: React.ElementType
}

export interface SettingsShellProps {
  // The built-in sections, already filtered by the host to what this reader
  // may see -- an admin-only page is simply not handed to the menu, rather
  // than handed over and bounced on press.
  sections: SettingsSection[]
  // The active section id. Controlled: the host owns the section, usually in
  // the URL, and is told when the reader chooses another.
  value: string
  onValueChange: (id: string) => void
  // Whether a section is open on a small screen, where the menu column takes
  // the whole width and choosing a section is what opens the panel. onClosed
  // fires when the reader leaves the section back to the menu.
  isOpened: boolean
  onClosed?: () => void
  // Extra menu content beneath the sections -- the extension pages, or
  // anything else the host adds to the menu.
  menuExtra?: React.ReactNode
  // The active section's content.
  children: React.ReactNode
  className?: string
}

const ENTRY_CLASS = 'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors'

// The settings page frame. One menu column beside one panel: a section that
// swaps the panel while staying on the settings route, rather than a page
// per section, so the menu -- the map of everything that can be set -- never
// goes away while a setting is being changed.
//
// The shell decides the shape and nothing else. Which sections exist, which
// of them this reader may see, and which is active are the host's: sections
// arrive as data, the selection arrives as a prop and leaves as a callback.
// Extension pages and anything else that joins the menu arrive as a slot
// beneath the sections, so the loader that knows about extensions stays with
// the host. Below the md breakpoint the MenuLayout underneath takes over:
// the menu column takes the whole width, and choosing a section is what
// opens the panel.
export function SettingsShell({
  sections,
  value,
  onValueChange,
  isOpened,
  onClosed,
  menuExtra,
  children,
  className,
}: SettingsShellProps) {
  const menu = (
    <nav className={cn('p-2 space-y-1', className)}>
      {sections.map((section) => {
        const Icon = section.icon
        return (
          <button
            type='button'
            key={section.id}
            onClick={() => onValueChange(section.id)}
            className={cn(ENTRY_CLASS, value === section.id ? 'bg-accent font-medium' : 'hover:bg-accent/50')}
            aria-current={value === section.id ? 'page' : undefined}
          >
            {Icon ? <Icon className='h-4 w-4 shrink-0' aria-hidden='true' /> : null}
            {section.label}
          </button>
        )
      })}
      {menuExtra}
    </nav>
  )

  return (
    <MenuLayout isOpened={isOpened} onClosed={onClosed} menu={menu}>
      <ScrollPage>
        <ScrollContent className='p-4'>{children}</ScrollContent>
      </ScrollPage>
    </MenuLayout>
  )
}
