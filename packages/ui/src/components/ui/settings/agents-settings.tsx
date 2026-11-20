'use client'

import type React from 'react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs'

export type AgentsSettingsTab = 'sessions' | 'usage' | 'audit'

export interface AgentsSettingsProps {
  // The open tab. Controlled: the host owns it, usually in the URL so each tab
  // is linkable, and is told when the reader picks another one.
  tab: AgentsSettingsTab
  onTabChange: (tab: AgentsSettingsTab) => void
  // Each tab's panel. Only the open tab's panel is mounted, so a panel that
  // polls the server stops while the reader is on another tab.
  sessions: React.ReactNode
  usage: React.ReactNode
  audit: React.ReactNode
}

// The Agents settings section: what the instance's agents are running, what
// they spent, and what they called. The section decides the tabs and their
// order; what each tab shows is the host's, handed in as a panel.
export function AgentsSettings({ tab, onTabChange, sessions, usage, audit }: AgentsSettingsProps) {
  return (
    <Tabs value={tab} onValueChange={(value) => onTabChange(value as AgentsSettingsTab)} className='gap-0'>
      <div className='px-6 pt-6'>
        <TabsList>
          <TabsTrigger value='sessions'>Sessions</TabsTrigger>
          <TabsTrigger value='usage'>Usage</TabsTrigger>
          <TabsTrigger value='audit'>MCP Audit</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value='sessions'>{sessions}</TabsContent>
      <TabsContent value='usage'>{usage}</TabsContent>
      <TabsContent value='audit'>{audit}</TabsContent>
    </Tabs>
  )
}
