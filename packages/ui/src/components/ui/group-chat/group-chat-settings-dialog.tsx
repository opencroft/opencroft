'use client'

import { Archive, ShieldCheck, Users, XIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'

import { BackButton } from '../utils/back-button'
import { Button } from '../button'
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '../dialog'
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
  /** Which section shows first each time the dialog opens. Given, a narrow
   *  screen opens straight into it instead of the section list. */
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
// menu and the section each scroll inside. The menu is the shell's narrow
// column: its three entries are short, and the section beside it is where the
// lists are.
//
// The header is one row of the dialog's own close button's height plus the
// kit dialog's 1rem inset above and below, so the close button sits where the
// kit dialog puts it (1rem from the top and the right) and the title is
// centred on it. The close button is in that row rather than over it, so a
// long section name truncates before it and Tab reaches it right after the
// title, before the menu.
//
// Below the md breakpoint the shell's own narrow form applies: the section
// list takes the whole width, choosing a section opens it, and Back returns to
// the list. That Back lives in this dialog's header, beside the section's
// name. The shell draws a Back of its own only when given onClosed, so this
// passes none. Each opening starts over from defaultSection, so a phone that
// closed the dialog inside a section opens it on the list again.
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
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      // Once the closing animation has ended, so the reset is never seen.
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) {
          setSection(defaultSection ?? 'members')
          setSectionOpened(defaultSection !== undefined)
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className='h-[min(36rem,calc(100dvh-2rem))] gap-0 overflow-hidden p-0 sm:max-w-4xl'
      >
        <DialogHeader className='h-16 shrink-0 flex-row items-center gap-2 border-b px-4'>
          {sectionOpened ? (
            <BackButton className='md:hidden' label='Back to settings' onClick={() => setSectionOpened(false)} />
          ) : null}
          <DialogTitle className='min-w-0 flex-1 truncate'>
            <span className={sectionOpened ? 'hidden md:inline' : undefined}>Chat settings</span>
            {title ? <span className='md:hidden'>{title}</span> : null}
          </DialogTitle>
          <DialogClose render={<Button variant='ghost' size='icon-sm' />}>
            <XIcon />
            <span className='sr-only'>Close</span>
          </DialogClose>
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
            menuWidth='narrow'
          >
            {content}
          </SettingsShell>
        </div>
      </DialogContent>
    </Dialog>
  )
}
