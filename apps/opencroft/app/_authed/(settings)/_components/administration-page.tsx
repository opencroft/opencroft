'use client'

import { useLoaderData } from '@tanstack/react-router'
import { Archive, Bot, Library, PackageSearch, Users } from 'lucide-react'
import { Suspense } from 'react'

import AgentsSettings from '@/app/_authed/(settings)/_components/agents-settings'
import BackupSettings from '@/app/_authed/(settings)/_components/backup-settings'
import ExtensionRegistriesSettings from '@/app/_authed/(settings)/_components/extension-registries-settings'
import { type BuiltinSection, SectionsPage } from '@/app/_authed/(settings)/_components/sections-page'
import UnknownTypesSettings from '@/app/_authed/(settings)/_components/unknown-types-settings'
import UsersSettings from '@/app/_authed/(settings)/_components/users-settings'
import {
  ADMINISTRATION_SECTION_IDS,
  type AdministrationSectionId,
} from '@/app/_authed/(settings)/_lib/administration-sections'
import { InstanceKeysStrip } from '@/app/_components/instance-keys-strip'

const SECTIONS: Record<AdministrationSectionId, Omit<BuiltinSection, 'id'>> = {
  agents: { label: 'Agents', icon: Bot, component: AgentsSettings },
  backup: { label: 'Backup & Restore', icon: Archive, component: BackupSettings },
  users: { label: 'Users', icon: Users, component: UsersSettings },
  'extension-registries': { label: 'Extension registries', icon: Library, component: ExtensionRegistriesSettings },
  'unknown-types': { label: 'Unknown Types', icon: PackageSearch, component: UnknownTypesSettings },
}

const ADMINISTRATION_SECTIONS: BuiltinSection[] = ADMINISTRATION_SECTION_IDS.map((id) => ({ id, ...SECTIONS[id] }))

// Only an administrator reaches this page: `/_authed` turns anyone else away
// before it loads, so nothing here is filtered by role.
function AdministrationContent() {
  // Null once no instance key comes from the key file.
  const { keyFileNotice } = useLoaderData({ from: '/_authed/(settings)/administration' })
  return (
    <SectionsPage
      page='/administration'
      sections={ADMINISTRATION_SECTIONS}
      banner={keyFileNotice ? <InstanceKeysStrip notice={keyFileNotice} /> : undefined}
    />
  )
}

export default function AdministrationPage() {
  return (
    <Suspense>
      <AdministrationContent />
    </Suspense>
  )
}
