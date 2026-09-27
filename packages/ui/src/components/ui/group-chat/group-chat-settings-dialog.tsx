'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'

import { Button } from '../button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../dialog'

export type GroupChatSettingsSection = 'members' | 'permissions' | 'archive'

const SECTIONS: Array<{ id: GroupChatSettingsSection; label: string }> = [
  { id: 'members', label: 'Members' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'archive', label: 'Archive' },
]

export interface GroupChatSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Which section shows first. Uncontrolled beyond that -- once open, the
   *  dialog owns which section is active, the same as any tabbed surface. */
  defaultSection?: GroupChatSettingsSection
  /** Who is in the chat, and adding to it -- the same picker a chat's members
   *  control has always shown. */
  members: ReactNode
  /** The automated-sender grants -- the scheduled pipelines and webhooks this
   *  chat lets deliver into its threads. */
  permissions: ReactNode
  /** The chat's archived threads, by folder. */
  archive: ReactNode
}

// The chat's settings, as a dialog with three sections rather than the single
// popover of members it used to be. Program logic stays entirely with the
// host -- every section is a slot, and this only decides the shape: a row of
// section buttons over one panel, the same hand-rolled switch Settings Shell
// uses for its own fixed menu of sections, sized for a dialog rather than a
// page. Three short labels never crowd a phone-width dialog the way a longer
// set would, so no separate narrow layout is needed.
export function GroupChatSettingsDialog({
  open,
  onOpenChange,
  defaultSection = 'members',
  members,
  permissions,
  archive,
}: GroupChatSettingsDialogProps) {
  const [section, setSection] = useState<GroupChatSettingsSection>(defaultSection)
  const content = section === 'members' ? members : section === 'permissions' ? permissions : archive
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>Chat settings</DialogTitle>
        </DialogHeader>
        <div className='flex gap-1 rounded-lg bg-muted p-1'>
          {SECTIONS.map((s) => (
            <Button
              key={s.id}
              type='button'
              size='sm'
              variant={section === s.id ? 'default' : 'ghost'}
              className='flex-1'
              onClick={() => setSection(s.id)}
              aria-current={section === s.id ? 'true' : undefined}
            >
              {s.label}
            </Button>
          ))}
        </div>
        <div className='max-h-[60vh] overflow-y-auto'>{content}</div>
      </DialogContent>
    </Dialog>
  )
}
