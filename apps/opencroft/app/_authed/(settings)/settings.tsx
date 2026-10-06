import { createFileRoute, redirect } from '@tanstack/react-router'

import SettingsPage from '@/app/_authed/(settings)/_components/settings-page'
import { pageTitle } from '@/app/_lib/page-title'

const nonEmpty = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

export const Route = createFileRoute('/_authed/(settings)/settings')({
  // Which section is open rides in the URL, so every section is linkable.
  // The default (Account) is carried as absence to keep the bare address
  // clean. Left as a free-form string because extension settings pages
  // register their own section ids at runtime. `tab` is the open tab of a
  // section that has tabs.
  validateSearch: (search: Record<string, unknown>): { section?: string; tab?: string } => ({
    section: nonEmpty(search.section),
    tab: nonEmpty(search.tab),
  }),
  // `section=audit` is a published address (bookmarks, agent instructions)
  // for the audit log, which lives in the Agents section's MCP Audit tab.
  beforeLoad: ({ search }) => {
    if (search.section === 'audit') {
      throw redirect({ to: '/settings', search: { section: 'agents', tab: 'audit' }, replace: true })
    }
  },
  head: () => ({ meta: [{ title: pageTitle('Settings') }] }),
  component: SettingsPage,
})
