'use client'

import { useRouteContext } from '@tanstack/react-router'
import { Archive, ScrollText, User, Users } from 'lucide-react'
import type React from 'react'
import { Suspense, useCallback } from 'react'
import { MenuLayout } from 'ui/layout/menulayout'
import { ScrollContent, ScrollPage } from 'ui/layout/scrollpage'

import AccountSettings from '@/app/_authed/(settings)/_components/account-settings'
import AuditSettings from '@/app/_authed/(settings)/_components/audit-settings'
import BackupSettings from '@/app/_authed/(settings)/_components/backup-settings'
import {
  ExtensionSettingsMenu,
  findExtensionPage,
  useExtensionSettings,
} from '@/app/_authed/(settings)/_components/extension-settings'
import UsersSettings from '@/app/_authed/(settings)/_components/users-settings'
import { useUrlState } from '@/components/hooks/use-url-state'
import { cn } from '@/lib/utils'

// A section that swaps the panel beside the menu, staying on /settings.
interface BuiltinPage {
  id: string
  label: string
  icon: React.ElementType
  component: React.ComponentType
  /** Rendered only for an administrator — see the visibility note below. */
  adminOnly?: boolean
}

const BUILTIN_PAGES: BuiltinPage[] = [
  { id: 'account', label: 'Account', icon: User, component: AccountSettings },
  { id: 'audit', label: 'MCP Audit', icon: ScrollText, component: AuditSettings },
  { id: 'backup', label: 'Backup & Restore', icon: Archive, component: BackupSettings },
  { id: 'users', label: 'Users', icon: Users, component: UsersSettings, adminOnly: true },
]

const ENTRY_CLASS = 'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors'

function SettingsContent() {
  const [section, setSection] = useUrlState<string>('section', '')
  const value = section || BUILTIN_PAGES[0].id
  const onClosed = useCallback(() => setSection(''), [setSection])
  const settings = useExtensionSettings()

  // The SAME fact /_authed's beforeLoad just redirected on, handed down as
  // route context rather than asked again here. Deliberately not a second
  // call or a second copy of the rule: if the two could disagree, the loser
  // is a menu entry that bounces the person who clicks it.
  const { isAdmin } = useRouteContext({ from: '/_authed' })
  const builtinPages = BUILTIN_PAGES.filter((page) => !page.adminOnly || isAdmin)

  const builtin = builtinPages.find((p) => p.id === value)
  const extensionPage = !builtin ? findExtensionPage(settings, value) : null
  const ActiveComponent = builtin?.component ?? extensionPage?.component

  const menu = (
    <nav className='p-2 space-y-1'>
      {builtinPages.map((page) => {
        const Icon = page.icon
        return (
          <button
            type='button'
            key={page.id}
            onClick={() => setSection(page.id)}
            className={cn(ENTRY_CLASS, value === page.id ? 'bg-accent font-medium' : 'hover:bg-accent/50')}
          >
            <Icon className='h-4 w-4 shrink-0' />
            {page.label}
          </button>
        )
      })}
      <ExtensionSettingsMenu activeId={value} onSelect={setSection} />
    </nav>
  )

  return (
    <MenuLayout isOpened={!!section} onClosed={onClosed} menu={menu}>
      <ScrollPage>
        <ScrollContent className='p-4'>{ActiveComponent && <ActiveComponent />}</ScrollContent>
      </ScrollPage>
    </MenuLayout>
  )
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsContent />
    </Suspense>
  )
}
