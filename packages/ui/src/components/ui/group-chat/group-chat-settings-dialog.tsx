'use client'

import { Archive, ShieldCheck, Users } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'

import { BackButton } from '../utils/back-button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../dialog'
import { type SettingsSection, SettingsShell } from '../settings/settings-shell'

export type GroupChatSettingsSection = 'members' | 'permissions' | 'archive'

const SECTIONS: Array<SettingsSection & { id: GroupChatSettingsSection }> = [
  { id: 'members', label: 'Members', icon: Users },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'archive', label: 'Archive', icon: Archive },
]

export interface GroupChatSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Which section shows first. Given, a narrow screen opens straight into it
   *  instead of the section list. Uncontrolled beyond that. */
  defaultSection?: GroupChatSettingsSection
  /** Who is in the chat, and adding to it. */
  members: ReactNode
  /** The automated-sender grants -- the scheduled pipelines and webhooks this
   *  chat lets deliver into its threads. */
  permissions: ReactNode
  /** The chat's archived threads, by folder. */
  archive: ReactNode
}

// The chat's settings: Settings Shell -- the settings page's own left menu of
// sections beside the section -- inside a dialog of one fixed size. The box is
// set on the dialog rather than grown from its content, so switching sections
// or a search that finds more or fewer rows never resizes or moves it; the
// menu and the section each scroll inside.
//
// Below the md breakpoint the shell's own narrow form applies: the section
// list takes the whole width, choosing a section opens it, and Back returns to
// the list. That Back lives in this dialog's header, beside the section's
// name. The shell draws a Back of its own only when given onClosed, so this
// passes none.
export function GroupChatSettingsDialog({
  open,
  onOpenChange,
  defaultSection,
  members,
  permissions,
  archive,
}: GroupChatSettingsDialogProps) {
  const [section, setSection] = useState<GroupChatSettingsSection>(defaultSection ?? 'members')
  const [sectionOpened, setSectionOpened] = useState(defaultSection !== undefined)
  const content = section === 'members' ? members : section === 'permissions' ? permissions : archive
  const title = sectionOpened ? SECTIONS.find((s) => s.id === section)?.label : undefined
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex h-[min(32rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl'>
        <DialogHeader className='flex-row items-center gap-2 border-b px-4 py-3'>
          {sectionOpened ? (
            <BackButton className='md:hidden' label='Back to settings' onClick={() => setSectionOpened(false)} />
          ) : null}
          <DialogTitle>
            <span className={sectionOpened ? 'hidden md:inline' : undefined}>Chat settings</span>
            {title ? <span className='md:hidden'>{title}</span> : null}
          </DialogTitle>
        </DialogHeader>
        <div className='flex min-h-0 flex-1'>
          <SettingsShell
            sections={SECTIONS}
            value={section}
            onValueChange={(id) => {
              setSection(id as GroupChatSettingsSection)
              setSectionOpened(true)
            }}
            isOpened={sectionOpened}
          >
            {content}
          </SettingsShell>
        </div>
      </DialogContent>
    </Dialog>
  )
}
