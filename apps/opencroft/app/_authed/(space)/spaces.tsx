import { createFileRoute } from '@tanstack/react-router'

import { SpacesTable } from '@/app/_authed/(space)/_components/spaces-table'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(space)/spaces')({
  // `?new=1` opens the new-space dialog on arrival -- where the title bar's
  // plus beside the space search leads.
  validateSearch: (search: Record<string, unknown>): { new?: boolean } => ({
    new: search.new === 1 || search.new === '1' || search.new === true ? true : undefined,
  }),
  loader: () => listSpaces(),
  head: () => ({ meta: [{ title: pageTitle('Spaces') }] }),
  component: SpacesPage,
})

function SpacesPage() {
  const spaces = Route.useLoaderData()
  const { new: startNew } = Route.useSearch()
  return <SpacesTable initialSpaces={spaces} startNew={startNew} />
}
