'use client'

import { type AgentsSettingsTab, AgentsSettings as AgentsSettingsView } from 'ui/settings/agents-settings'

import AuditSettings from '@/app/_authed/(settings)/_components/audit-settings'
import SessionsSettings from '@/app/_authed/(settings)/_components/sessions-settings'
import { useSettingsLocation } from '@/app/_authed/(settings)/_lib/settings-location'

// The open tab rides in the URL beside the section, so each tab is linkable.
// Anything but the audit tab's id reads as the default, Sessions, which is
// carried as absence.
export default function AgentsSettings() {
  const { tab, openTab } = useSettingsLocation()
  const shownTab: AgentsSettingsTab = tab === 'audit' ? 'audit' : 'sessions'

  return (
    <AgentsSettingsView
      tab={shownTab}
      onTabChange={(next) => openTab(next === 'audit' ? next : '')}
      sessions={<SessionsSettings />}
      audit={<AuditSettings />}
    />
  )
}
