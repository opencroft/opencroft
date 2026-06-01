'use client'

import { ExternalLink, ScrollText, Sparkles } from 'lucide-react'
import type React from 'react'
import { Suspense, useCallback } from 'react'

import AppLinksSettings from '@/app/(applink)/_components/applinks-settings'
import AiSettings from '@/app/(settings)/_components/ai-settings'
import AuditSettings from '@/app/(settings)/_components/audit-settings'
import { ExtensionSettingsMenu, findExtensionPage, useExtensionSettings } from '@/app/(settings)/_components/extension-settings'
import { useUrlState } from '@/components/hooks/use-url-state'
import { MenuLayout } from '@/components/ui/layout/menulayout'
import { ScrollContent, ScrollPage } from '@/components/ui/layout/scrollpage'
import { cn } from '@/lib/utils'

interface BuiltinPage {
  id: string
  label: string
  icon: React.ElementType
  component: React.ComponentType
}

const BUILTIN_PAGES: BuiltinPage[] = [
  { id: 'ai', label: 'AI', icon: Sparkles, component: AiSettings },
  { id: 'applinks', label: 'App Links', icon: ExternalLink, component: AppLinksSettings },
  { id: 'audit', label: 'MCP Audit', icon: ScrollText, component: AuditSettings },
]

function SettingsContent() {
  const [section, setSection] = useUrlState<string>('section', '')
  const value = section || BUILTIN_PAGES[0].id
  const onClosed = useCallback(() => setSection(''), [setSection])
  const settings = useExtensionSettings()

  const builtin = BUILTIN_PAGES.find((p) => p.id === value)
  const extensionPage = !builtin ? findExtensionPage(settings, value) : null
  const ActiveComponent = builtin?.component ?? extensionPage?.component

  const menu = (
    <nav className='p-2 space-y-1'>
      {BUILTIN_PAGES.map((page) => {
        const Icon = page.icon
        return (
          <button
            key={page.id}
            onClick={() => setSection(page.id)}
            className={cn('w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors', value === page.id ? 'bg-accent font-medium' : 'hover:bg-accent/50')}
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
