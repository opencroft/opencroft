'use client'

import { type AgentsSettingsTab, AgentsSettings as AgentsSettingsView } from 'ui/settings/agents-settings'

import AuditSettings from '@/app/_authed/(settings)/_components/audit-settings'
import SessionsSettings from '@/app/_authed/(settings)/_components/sessions-settings'
import { useUrlState } from '@/components/hooks/use-url-state'

// The open tab rides in the URL beside the section, so each tab is linkable.
// Anything but the audit tab's id reads as the default, Sessions.
export default function AgentsSettings() {
  const [tab, setTab] = useUrlState<string>('tab', 'sessions')
  const openTab: AgentsSettingsTab = tab === 'audit' ? 'audit' : 'sessions'

  return (
    <AgentsSettingsView tab={openTab} onTabChange={setTab} sessions={<SessionsSettings />} audit={<AuditSettings />} />
  )
}
