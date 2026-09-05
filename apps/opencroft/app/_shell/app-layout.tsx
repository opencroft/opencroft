import { listPinnedDashboards } from '@opencroft/dashboards/server'

import { AppShell } from '@/app/_shell/app-shell'
import { listDashboards } from '@/app/_authed/(dashboards)/_server/actions'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'

export async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const [spaces, dashboards, pinnedDashboardSlugs] = await Promise.all([
    listSpaces(),
    listDashboards(),
    listPinnedDashboards(),
  ])
  return (
    <AppShell spaces={spaces} dashboards={dashboards} pinnedDashboardSlugs={pinnedDashboardSlugs}>
      {children}
    </AppShell>
  )
}
