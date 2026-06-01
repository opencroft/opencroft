import { createFileRoute } from '@tanstack/react-router';

import AppDashboardPage from '@/app/(legacy-app-dashboard)/legacy-dashboard/page';

export const Route = createFileRoute('/(legacy-app-dashboard)/legacy-dashboard')({
  component: AppDashboardPage,
});
