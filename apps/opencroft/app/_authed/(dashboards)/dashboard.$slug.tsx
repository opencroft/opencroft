import { createFileRoute, notFound } from '@tanstack/react-router'

import { DashboardPage } from '@/app/_authed/(dashboards)/_components/dashboard-page'
import { listDashboards } from '@/app/_authed/(dashboards)/_server/actions'

export const Route = createFileRoute('/_authed/(dashboards)/dashboard/$slug')({
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
