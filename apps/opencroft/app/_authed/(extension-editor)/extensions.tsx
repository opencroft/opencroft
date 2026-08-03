import { createFileRoute } from '@tanstack/react-router'

import ExtensionsPage from '@/app/_authed/(extension-editor)/_components/extensions-page'

export const Route = createFileRoute('/_authed/(extension-editor)/extensions')({
  component: ExtensionsPage,
})
