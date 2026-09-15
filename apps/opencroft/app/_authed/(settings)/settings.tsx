import { createFileRoute } from '@tanstack/react-router'

import SettingsPage from '@/app/_authed/(settings)/_components/settings-page'

export const Route = createFileRoute('/_authed/(settings)/settings')({
  // Which section is open rides in the URL, so every section is linkable.
  // The default (Account) is carried as absence to keep the bare address
  // clean. Left as a free-form string because extension settings pages
  // register their own section ids at runtime.
  validateSearch: (search: Record<string, unknown>): { section?: string } => ({
    section: typeof search.section === 'string' && search.section ? search.section : undefined,
  }),
  component: SettingsPage,
})
