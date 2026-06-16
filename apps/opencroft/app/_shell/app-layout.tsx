import { listPinnedDashboards } from '@opencroft/dashboards/server'

import { AppShell } from '@/app/_shell/app-shell'
import { listDashboards } from '@/app/(dashboards)/_server/actions'
import { listSpaces } from '@/app/(space)/_server/actions'

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
  const pinnedSpaces = spaces.filter((s) => s.pinned)
  return (
    <AppShell pinnedSpaces={pinnedSpaces} dashboards={dashboards} pinnedDashboardSlugs={pinnedDashboardSlugs}>
      {children}
    </AppShell>
  )
}
