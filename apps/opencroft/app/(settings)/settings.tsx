import { createFileRoute } from '@tanstack/react-router'

import SettingsPage from '@/app/(settings)/_components/settings-page'

export const Route = createFileRoute('/(settings)/settings')({
  component: SettingsPage,
})
