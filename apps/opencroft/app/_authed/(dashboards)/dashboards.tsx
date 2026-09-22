import { DashboardsPage } from '@opencroft/dashboards/client'
import { listPinnedDashboards } from '@opencroft/dashboards/server'
import { createFileRoute } from '@tanstack/react-router'

import { listDashboards } from '@/app/_authed/(dashboards)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(dashboards)/dashboards')({
  loader: async () => {
    const [dashboards, pinned] = await Promise.all([listDashboards(), listPinnedDashboards()])
    return { dashboards, pinned }
  },
  head: () => ({ meta: [{ title: pageTitle('Dashboards') }] }),
  component: Page,
})

function Page() {
  const { dashboards, pinned } = Route.useLoaderData()
  return <DashboardsPage dashboards={dashboards} initialPinned={pinned} />
}
