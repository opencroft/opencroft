import { createFileRoute } from '@tanstack/react-router'

import ExtensionsPage from '@/app/(extension-editor)/_components/extensions-page'

export const Route = createFileRoute('/(extension-editor)/extensions')({
  component: ExtensionsPage,
})
