import { createFileRoute } from '@tanstack/react-router'

import DocsPage from '@/app/(docs)/_components/docs-page-client'

export const Route = createFileRoute('/(docs)/docs')({
  component: DocsPage,
})
