import { createFileRoute } from '@tanstack/react-router'
import { SpacesTable } from '@/app/(space)/_components/spaces-table'
import { listSpaces } from '@/app/(space)/_server/actions'

export const Route = createFileRoute('/(space)/spaces')({
  loader: () => listSpaces(),
  component: SpacesPage,
})

function SpacesPage() {
  const spaces = Route.useLoaderData()
  return <SpacesTable initialSpaces={spaces} />
}
