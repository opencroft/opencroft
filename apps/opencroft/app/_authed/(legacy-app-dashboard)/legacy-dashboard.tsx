import { createFileRoute } from '@tanstack/react-router'

import AppDashboardPage from '@/app/_authed/(legacy-app-dashboard)/_legacy/legacy-dashboard/page'

export const Route = createFileRoute('/_authed/(legacy-app-dashboard)/legacy-dashboard')({
  component: AppDashboardPage,
})
