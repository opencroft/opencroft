import { createFileRoute, notFound } from '@tanstack/react-router'

import { DashboardPage } from '@/app/(dashboards)/_components/dashboard-page'
import { listDashboards } from '@/app/(dashboards)/_server/actions'

export const Route = createFileRoute('/(dashboards)/dashboard/$slug')({
  loader: async ({ params }) => {
    const dashboards = await listDashboards()
    const meta = dashboards.find((dashboard) => dashboard.slug === params.slug)
    if (!meta) {
      throw notFound()
    }
    return { meta }
  },
  component: Page,
})

function Page() {
  const { meta } = Route.useLoaderData()
  return <DashboardPage meta={meta} />
}
