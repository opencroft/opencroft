import { createFileRoute } from '@tanstack/react-router'

import AppDashboardPage from '@/app/_authed/(legacy-app-dashboard)/_legacy/legacy-dashboard/page'
import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(legacy-app-dashboard)/legacy-dashboard')({
  head: () => ({ meta: [{ title: pageTitle('Legacy dashboard') }] }),
  component: AppDashboardPage,
})
