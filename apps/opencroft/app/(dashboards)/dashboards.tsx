import { DashboardsPage } from '@opencroft/dashboards/client'
import { listPinnedDashboards } from '@opencroft/dashboards/server'
import { createFileRoute } from '@tanstack/react-router'

import { listDashboards } from '@/app/(dashboards)/_server/actions'

export const Route = createFileRoute('/(dashboards)/dashboards')({
  loader: async () => {
    const [dashboards, pinned] = await Promise.all([listDashboards(), listPinnedDashboards()])
    return { dashboards, pinned }
  },
  component: Page,
})

function Page() {
  const { dashboards, pinned } = Route.useLoaderData()
  return <DashboardsPage dashboards={dashboards} initialPinned={pinned} />
}
