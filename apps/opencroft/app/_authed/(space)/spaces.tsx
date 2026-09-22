import { createFileRoute } from '@tanstack/react-router'

import { SpacesTable } from '@/app/_authed/(space)/_components/spaces-table'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(space)/spaces')({
  loader: () => listSpaces(),
  head: () => ({ meta: [{ title: pageTitle('Spaces') }] }),
  component: SpacesPage,
})

function SpacesPage() {
  const spaces = Route.useLoaderData()
  return <SpacesTable initialSpaces={spaces} />
}
