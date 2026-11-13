import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback } from 'react'

import { isSplitView } from '@/app/_shell/screen-stack'

/** The pages laid out as a menu of sections beside the open one. */
export type SectionsPagePath = '/settings' | '/administration'

export interface SectionSearch {
  section?: string
  tab?: string
}

const nonEmpty = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/**
 * A sections page's search. Which section is open rides in the URL, so every
 * section is linkable; the default section is carried as absence to keep the
 * bare address clean. Left as a free-form string because extension settings
 * pages register their own section ids at runtime. `tab` is the open tab of a
 * section that has tabs.
 */
export function validateSectionSearch(search: Record<string, unknown>): SectionSearch {
  return { section: nonEmpty(search.section), tab: nonEmpty(search.tab) }
}

const ROUTE_IDS = {
  '/settings': '/_authed/(settings)/settings',
  '/administration': '/_authed/(settings)/administration',
} as const satisfies Record<SectionsPagePath, string>

/**
 * Where the reader is inside a sections page (Settings or Administration) —
 * the open section and, in a section with tabs, the open tab — read from the
 * URL, with the moves between them.
 *
 * Opening a section is a screen of its own over the menu where the two are
 * apart (a phone), so it is pushed and Back returns to the menu; where they
 * sit side by side it replaces the entry, so Back leaves the page. A tab
 * changes in place and replaces the entry too. A move to where the reader
 * already is adds no entry.
 */
export function useSettingsLocation(page: SectionsPagePath) {
  const { section, tab } = useSearch({ from: ROUTE_IDS[page] })
  const navigate = useNavigate()

  // The whole search is replaced: a section's tab does not carry over to the
  // next section. Choosing the open section again keeps its tab. An empty id
  // is the menu (on a small screen, no section open).
  const openSection = useCallback(
    (id: string) => {
      if ((id || undefined) === section) return
      return navigate({ to: page, search: { section: id || undefined }, replace: isSplitView() })
    },
    [navigate, page, section],
  )
  // An empty id is the section's default tab, carried as absence.
  const openTab = useCallback(
    (id: string) => navigate({ to: page, search: { section, tab: id || undefined }, replace: true }),
    [navigate, page, section],
  )

  return { section, tab, openSection, openTab }
}
