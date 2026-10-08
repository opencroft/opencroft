import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback } from 'react'

/**
 * Where the reader is inside Settings — the open section and, in a section
 * with tabs, the open tab — read from the URL, with the moves between them.
 *
 * Every move is a navigation pushed onto history, so the browser's arrows and
 * the title bar's Back and Forward step through the sections and tabs the
 * reader opened. A move to where the reader already is adds no entry.
 */
export function useSettingsLocation() {
  const { section, tab } = useSearch({ from: '/_authed/(settings)/settings' })
  const navigate = useNavigate()

  // The whole search is replaced: a section's tab does not carry over to the
  // next section. Choosing the open section again keeps its tab. An empty id
  // is the menu (on a small screen, no section open).
  const openSection = useCallback(
    (id: string) => {
      if ((id || undefined) === section) return
      return navigate({ to: '/settings', search: { section: id || undefined } })
    },
    [navigate, section],
  )
  // An empty id is the section's default tab, carried as absence.
  const openTab = useCallback(
    (id: string) => navigate({ to: '/settings', search: { section, tab: id || undefined } }),
    [navigate, section],
  )

  return { section, tab, openSection, openTab }
}
