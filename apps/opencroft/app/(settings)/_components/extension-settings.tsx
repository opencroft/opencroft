'use client'

import { ChevronRight, Puzzle } from 'lucide-react'
import React, { useEffect, useState } from 'react'

import type { SettingsPageDefinition } from '@/app/(extension-runtime)/_client/host'
import { loadAllExtensions } from '@/app/(extension-runtime)/_client/loader'
import { extensionRegistry, type ResolvedExtensionSettings, resolveIcon } from '@/app/(extension-runtime)/_client/registry'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@opencroft/ui-kit/collapsible'
import { cn } from '@/lib/utils'

interface MenuButtonProps {
  active: boolean
  icon: React.ElementType
  label: string
  onClick: () => void
}

function MenuButton({ active, icon, label, onClick }: MenuButtonProps) {
  const Icon = icon
  return (
    <button onClick={onClick} className={cn('w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors', active ? 'bg-accent font-medium' : 'hover:bg-accent/50')}>
      <Icon className='h-4 w-4 shrink-0' />
      {label}
    </button>
  )
}

export function pageMenuId(extensionId: string, pageId: string): string {
  return `ext:${extensionId}:${pageId}`
}

interface ExtensionMenuProps {
  activeId: string
  onSelect: (id: string) => void
}

function ExtensionGroup({ settings, activeId, onSelect }: { settings: ResolvedExtensionSettings; activeId: string; onSelect: (id: string) => void }) {
  const containsActive = settings.pages.some((p) => pageMenuId(settings.extensionId, p.id) === activeId)
  return (
    <Collapsible defaultOpen={containsActive} className='group/ext'>
      <CollapsibleTrigger className={cn('w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors hover:bg-accent/50')}>
        <Puzzle className='h-4 w-4 shrink-0' />
        <span className='flex-1 text-left'>{settings.extensionName}</span>
        <ChevronRight className='h-4 w-4 transition-transform duration-200 group-data-[state=open]/ext:rotate-90' />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className='pl-4 mt-1 space-y-1'>
          {settings.pages.map((page) => {
            const id = pageMenuId(settings.extensionId, page.id)
            return <MenuButton key={id} active={activeId === id} icon={resolveIcon(page.icon)} label={page.label} onClick={() => onSelect(id)} />
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ExtensionSettingsMenu({ activeId, onSelect }: ExtensionMenuProps) {
  const settings = useExtensionSettings()
  return (
    <>
      {settings.map((entry) => {
        if (entry.pages.length === 1) {
          const page = entry.pages[0]
          const id = pageMenuId(entry.extensionId, page.id)
          return <MenuButton key={id} active={activeId === id} icon={resolveIcon(page.icon)} label={entry.extensionName} onClick={() => onSelect(id)} />
        }
        return <ExtensionGroup key={entry.extensionId} settings={entry} activeId={activeId} onSelect={onSelect} />
      })}
    </>
  )
}

export function findExtensionPage(settings: ResolvedExtensionSettings[], activeId: string): SettingsPageDefinition | null {
  for (const entry of settings) {
    for (const page of entry.pages) {
      if (pageMenuId(entry.extensionId, page.id) === activeId) {
        return page
      }
    }
  }
  return null
}

export function useExtensionSettings(): ResolvedExtensionSettings[] {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    loadAllExtensions().then(() => setVersion((v) => v + 1))
  }, [])
  return React.useMemo(() => {
    void version
    return extensionRegistry.allSettings()
  }, [version])
}
