'use client'

import type React from 'react'
import { TitleBarTitle } from 'ui/layouts/title-bar'
import { type SettingsSection, SettingsShell } from 'ui/settings/settings-shell'

import { type SectionsPagePath, useSettingsLocation } from '@/app/_authed/(settings)/_lib/settings-location'

/** A section that swaps the panel beside the menu, staying on its page. */
export interface BuiltinSection extends SettingsSection {
  component: React.ComponentType
}

/** A section found by id outside the page's own list: an extension's page. */
export interface FoundSection {
  label: string
  component: React.ComponentType
}

interface SectionsPageProps {
  page: SectionsPagePath
  sections: BuiltinSection[]
  /** Menu entries beneath the page's own sections, given the open id and the move to another. */
  menuExtra?: (activeId: string, open: (id: string) => void) => React.ReactNode
  /** Resolves an id that is not one of `sections`, for the entries in `menuExtra`. */
  findSection?: (id: string) => FoundSection | null
  banner?: React.ReactNode
}

// The frame is the kit's SettingsShell; what stays here is reading the open
// section from the URL and drawing it. Which sections a page has, and who may
// open the page, are the page's.
export function SectionsPage({ page, sections, menuExtra, findSection, banner }: SectionsPageProps) {
  const { section, openSection } = useSettingsLocation(page)
  const value = section || sections[0].id

  const builtin = sections.find((s) => s.id === value)
  const shown: FoundSection | null = builtin ?? findSection?.(value) ?? null
  const ActiveComponent = shown?.component

  // On a phone an open section is a screen of its own: the title bar names it
  // and its Back returns to the menu (the shell's screen stack), so the
  // layout draws no Back of its own above the section.
  return (
    <SettingsShell
      sections={sections}
      value={value}
      onValueChange={openSection}
      isOpened={!!section}
      menuExtra={menuExtra?.(value, openSection)}
      banner={banner}
    >
      {section && shown && (
        <TitleBarTitle>
          <span className='md:hidden'>{shown.label}</span>
        </TitleBarTitle>
      )}
      {ActiveComponent && <ActiveComponent />}
    </SettingsShell>
  )
}
