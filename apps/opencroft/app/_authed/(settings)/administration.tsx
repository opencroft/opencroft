import { createFileRoute } from '@tanstack/react-router'

import AdministrationPage from '@/app/_authed/(settings)/_components/administration-page'
import { validateSectionSearch } from '@/app/_authed/(settings)/_lib/settings-location'
import { getKeyFileNotice } from '@/app/_authed/(settings)/_server/instance-keys-actions'
import { pageTitle } from '@/app/_lib/page-title'

// The instance's settings, for an administrator only: `/_authed` sends
// anyone else to their own settings before this loads.
export const Route = createFileRoute('/_authed/(settings)/administration')({
  validateSearch: validateSectionSearch,
  // The key file's warning across the top.
  loader: async () => ({ keyFileNotice: await getKeyFileNotice() }),
  head: () => ({ meta: [{ title: pageTitle('Administration') }] }),
  component: AdministrationPage,
})
