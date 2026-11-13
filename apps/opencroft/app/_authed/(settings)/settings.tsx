import { createFileRoute, redirect } from '@tanstack/react-router'

import SettingsPage from '@/app/_authed/(settings)/_components/settings-page'
import { administrationSearch } from '@/app/_authed/(settings)/_lib/administration-sections'
import { validateSectionSearch } from '@/app/_authed/(settings)/_lib/settings-location'
import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(settings)/settings')({
  validateSearch: validateSectionSearch,
  // The instance's sections have published addresses here (bookmarks, agent
  // instructions), so each is sent on to its place on the administration
  // page. Whoever may not open that page is turned back to this one by
  // `/_authed`.
  beforeLoad: ({ search }) => {
    const moved = administrationSearch(search)
    if (moved) {
      throw redirect({ to: '/administration', search: moved, replace: true })
    }
  },
  head: () => ({ meta: [{ title: pageTitle('Settings') }] }),
  component: SettingsPage,
})
