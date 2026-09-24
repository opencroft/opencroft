'use client'

import { ChevronRight, Puzzle } from 'lucide-react'
import type React from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'ui/components/ui/collapsible'
import { cn } from 'ui/lib/utils'

export interface ExtensionSettingsPageEntry {
  id: string
  label: string
  // The host resolves the extension's own icon to a component; this only
  // renders it. Omitted means the entry stands on its label alone.
  icon?: React.ElementType
}

export interface ExtensionSettingsEntry {
  extensionId: string
  extensionName: string
  pages: ExtensionSettingsPageEntry[]
}

// The menu id of an extension's page. Exported because two parties must
// agree on it -- the menu, which reports a selection, and the host, which
// decides which page is active. Composing it in one place means they cannot
// drift apart.
export function extensionPageId(extensionId: string, pageId: string): string {
  return `ext:${extensionId}:${pageId}`
}

export interface ExtensionSettingsMenuProps {
  entries: ExtensionSettingsEntry[]
  // The active menu id, compared against the ids this menu composes. May be
  // a built-in page's id instead -- then nothing here reads as active.
  activeId: string
  onSelect: (id: string) => void
  className?: string
}

const ENTRY_CLASS = 'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors'

function MenuButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean
  icon?: React.ElementType
  label: string
  onClick: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(ENTRY_CLASS, active ? 'bg-accent font-medium' : 'hover:bg-accent/50')}
    >
      {Icon ? <Icon className='h-4 w-4 shrink-0' aria-hidden='true' /> : null}
      {label}
    </button>
  )
}

function ExtensionGroup({
  entry,
  activeId,
  onSelect,
}: {
  entry: ExtensionSettingsEntry
  activeId: string
  onSelect: (id: string) => void
}) {
  const containsActive = entry.pages.some((p) => extensionPageId(entry.extensionId, p.id) === activeId)
  return (
    <Collapsible defaultOpen={containsActive} className='group/ext'>
      <CollapsibleTrigger
        className={cn(
          'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors hover:bg-accent/50',
        )}
      >
        <Puzzle className='h-4 w-4 shrink-0' aria-hidden='true' />
        <span className='flex-1 text-left'>{entry.extensionName}</span>
        <ChevronRight
          className='h-4 w-4 transition-transform duration-200 group-data-open/ext:rotate-90'
          aria-hidden='true'
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className='pl-4 mt-1 space-y-1'>
          {entry.pages.map((page) => {
            const id = extensionPageId(entry.extensionId, page.id)
            return (
              <MenuButton
                key={id}
                active={activeId === id}
                icon={page.icon}
                label={page.label}
                onClick={() => onSelect(id)}
              />
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// The extension pages in the settings menu. An extension offering a single
// page appears as one entry under its own name -- a group holding one child
// would spend a whole collapsible to say what the entry itself already says.
// An extension with several pages becomes a collapsible group, opening onto
// its pages indented beneath; a group containing the active page starts open,
// because arriving somewhere and finding it closed is the menu contradicting
// the address bar.
//
// Presentation only: entries arrive as plain data (ids, labels, icons the
// host has already resolved), the selection arrives as a prop and leaves as
// a callback, and nothing about the extension runtime is known here.
export function ExtensionSettingsMenu({ entries, activeId, onSelect, className }: ExtensionSettingsMenuProps) {
  return (
    <div className={cn('space-y-1', className)}>
      {entries.map((entry) => {
        if (entry.pages.length === 1) {
          const page = entry.pages[0]
          const id = extensionPageId(entry.extensionId, page.id)
          return (
            <MenuButton
              key={id}
              active={activeId === id}
              icon={page.icon}
              label={entry.extensionName}
              onClick={() => onSelect(id)}
            />
          )
        }
        return <ExtensionGroup key={entry.extensionId} entry={entry} activeId={activeId} onSelect={onSelect} />
      })}
    </div>
  )
}
