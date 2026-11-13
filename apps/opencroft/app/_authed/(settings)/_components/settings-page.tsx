'use client'

import { User } from 'lucide-react'
import { Suspense } from 'react'
import { ExtensionSettingsMenu } from 'ui/settings/extension-settings-menu'

import AccountSettings from '@/app/_authed/(settings)/_components/account-settings'
import {
  extensionMenuEntries,
  findExtensionPage,
  useExtensionSettings,
} from '@/app/_authed/(settings)/_components/extension-settings'
import { type BuiltinSection, SectionsPage } from '@/app/_authed/(settings)/_components/sections-page'

// Settings: what belongs to the signed-in person. What configures the
// instance is on the administration page.
const SETTINGS_SECTIONS: BuiltinSection[] = [
  { id: 'account', label: 'Account', icon: User, component: AccountSettings },
]

function SettingsContent() {
  const settings = useExtensionSettings()
  // An extension's settings page declares no scope, so it is offered to every
  // signed-in person, here.
  return (
    <SectionsPage
      page='/settings'
      sections={SETTINGS_SECTIONS}
      menuExtra={(activeId, open) => (
        <ExtensionSettingsMenu entries={extensionMenuEntries(settings)} activeId={activeId} onSelect={open} />
      )}
      findSection={(id) => findExtensionPage(settings, id)}
    />
  )
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsContent />
    </Suspense>
  )
}
