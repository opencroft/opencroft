'use client'

import { X } from 'lucide-react'

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../input-group'
import { Switch } from '../switch'

export interface GroupChatThreadSearchProps {
  query: string
  onQueryChange: (query: string) => void
  /** Whether the chat's archived threads are searched too. */
  includeArchived: boolean
  onIncludeArchivedChange: (includeArchived: boolean) => void
  /** The X, and Escape in the field. */
  onClose: () => void
  placeholder?: string
}

// One line, because it stands in the header in place of the chat's name. The
// switch sits inside the field rather than under it so opening a search never
// pushes the thread list down, and its label stays a word rather than an icon:
// "Archived" is the one thing it can mean, and an archive glyph alone does not
// say whether it adds the archive or shows only it.
export function GroupChatThreadSearch({
  query,
  onQueryChange,
  includeArchived,
  onIncludeArchivedChange,
  onClose,
  placeholder = 'Search threads and messages…',
}: GroupChatThreadSearchProps) {
  return (
    <InputGroup className='h-8'>
      <InputGroupInput
        autoFocus
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose()
          }
        }}
        placeholder={placeholder}
        aria-label='Search threads and messages'
      />
      <InputGroupAddon align='inline-end'>
        <label className='flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground'>
          <Switch size='sm' checked={includeArchived} onCheckedChange={onIncludeArchivedChange} />
          Archived
        </label>
        <InputGroupButton size='icon-xs' aria-label='Close search' onClick={onClose}>
          <X />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
