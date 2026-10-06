'use client'

import { useRouteContext } from '@tanstack/react-router'
import { Archive, Bot, PackageSearch, User, Users } from 'lucide-react'
import type React from 'react'
import { Suspense, useCallback } from 'react'
import { ExtensionSettingsMenu } from 'ui/settings/extension-settings-menu'
import { type SettingsSection, SettingsShell } from 'ui/settings/settings-shell'

import AccountSettings from '@/app/_authed/(settings)/_components/account-settings'
import AgentsSettings from '@/app/_authed/(settings)/_components/agents-settings'
import BackupSettings from '@/app/_authed/(settings)/_components/backup-settings'
import {
  extensionMenuEntries,
  findExtensionPage,
  useExtensionSettings,
} from '@/app/_authed/(settings)/_components/extension-settings'
import UnknownTypesSettings from '@/app/_authed/(settings)/_components/unknown-types-settings'
import UsersSettings from '@/app/_authed/(settings)/_components/users-settings'
import { useUrlState } from '@/components/hooks/use-url-state'

// A section that swaps the panel beside the menu, staying on /settings.
// The frame is the kit's SettingsShell; what stays here is which sections
// exist, which of them this reader may see, and which component each one is.
interface BuiltinPage extends SettingsSection {
  component: React.ComponentType
  /** Rendered only for an administrator — see the visibility note below. */
  adminOnly?: boolean
}

const BUILTIN_PAGES: BuiltinPage[] = [
  { id: 'account', label: 'Account', icon: User, component: AccountSettings },
  { id: 'agents', label: 'Agents', icon: Bot, component: AgentsSettings },
  { id: 'backup', label: 'Backup & Restore', icon: Archive, component: BackupSettings },
  { id: 'users', label: 'Users', icon: Users, component: UsersSettings, adminOnly: true },
  {
    id: 'unknown-types',
    label: 'Unknown Types',
    icon: PackageSearch,
    component: UnknownTypesSettings,
    adminOnly: true,
  },
]

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

  return (
    <SettingsShell
      sections={builtinPages}
      value={value}
      onValueChange={setSection}
      isOpened={!!section}
      onClosed={onClosed}
      menuExtra={
        <ExtensionSettingsMenu entries={extensionMenuEntries(settings)} activeId={value} onSelect={setSection} />
      }
    >
      {ActiveComponent && <ActiveComponent />}
    </SettingsShell>
  )
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsContent />
    </Suspense>
  )
}
