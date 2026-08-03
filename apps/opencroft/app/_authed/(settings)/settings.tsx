import { createFileRoute } from '@tanstack/react-router'

import SettingsPage from '@/app/_authed/(settings)/_components/settings-page'

export const Route = createFileRoute('/_authed/(settings)/settings')({
  component: SettingsPage,
})
