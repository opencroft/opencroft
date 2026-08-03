'use client'

import { Link, type LinkProps, useRouteContext } from '@tanstack/react-router'
import { Archive, ChevronRight, ScrollText, User, Users } from 'lucide-react'
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
import { useUrlState } from '@/components/hooks/use-url-state'
import { cn } from '@/lib/utils'

// A section that swaps the panel beside the menu, staying on /settings.
interface BuiltinPage {
  id: string
  label: string
  icon: React.ElementType
  component: React.ComponentType
}

const BUILTIN_PAGES: BuiltinPage[] = [
  { id: 'account', label: 'Account', icon: User, component: AccountSettings },
  { id: 'audit', label: 'MCP Audit', icon: ScrollText, component: AuditSettings },
  { id: 'backup', label: 'Backup & Restore', icon: Archive, component: BackupSettings },
]

// An entry that LEAVES this page for a screen of its own.
//
// The user list is not a panel: it is a full screen with its own add and edit
// pages beneath it, and those pages need the whole width. Rendering it as a
// section would also give the list two addresses — /settings?section=users
// and /settings/users — and only the second is the one the route guard in
// _authed.tsx protects.
//
// So it navigates, and the menu says so with a chevron rather than dressing
// it up as a tab that swaps the panel. An entry that looks like the three
// above but replaces the whole page instead is a small lie about where the
// click goes.
interface LinkPage {
  id: string
  label: string
  icon: React.ElementType
  to: LinkProps['to']
  /** Rendered only for an administrator — see the visibility note below. */
  adminOnly?: boolean
}

const LINK_PAGES: LinkPage[] = [{ id: 'users', label: 'Users', icon: Users, to: '/settings/users', adminOnly: true }]

// Every menu entry, tab or link, shares this so the two kinds read as one
// list rather than two designs that happen to sit together.
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
  const linkPages = LINK_PAGES.filter((page) => !page.adminOnly || isAdmin)

  const builtin = BUILTIN_PAGES.find((p) => p.id === value)
  const extensionPage = !builtin ? findExtensionPage(settings, value) : null
  const ActiveComponent = builtin?.component ?? extensionPage?.component

  const menu = (
    <nav className='p-2 space-y-1'>
      {BUILTIN_PAGES.map((page) => {
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
      {linkPages.map((page) => {
        const Icon = page.icon
        return (
          <Link key={page.id} to={page.to} className={cn(ENTRY_CLASS, 'hover:bg-accent/50')}>
            <Icon className='h-4 w-4 shrink-0' />
            {page.label}
            {/* Says this one goes somewhere rather than swapping the panel. */}
            <ChevronRight className='h-4 w-4 shrink-0 ml-auto text-muted-foreground' />
          </Link>
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
