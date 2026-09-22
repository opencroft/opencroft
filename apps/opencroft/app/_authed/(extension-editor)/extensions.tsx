import { createFileRoute } from '@tanstack/react-router'

import { listExtensionsIndex } from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import ExtensionsPage from '@/app/_authed/(extension-editor)/_components/extensions-page'
import { pageTitle } from '@/app/_lib/page-title'

// The index is loaded by the ROUTE, not by the page: a loader runs before the
// component renders and its result travels with the document, so the list is
// on screen the moment the page is. Fetching it from an effect meant booting
// the app, hydrating, and only then asking — with an empty list drawn in the
// meantime, which is what made an instance with nine extensions look like one
// with none.
export const Route = createFileRoute('/_authed/(extension-editor)/extensions')({
  loader: async () => ({ index: await listExtensionsIndex() }),
  head: () => ({ meta: [{ title: pageTitle('Extensions') }] }),
  component: ExtensionsRoute,
})

function ExtensionsRoute() {
  const { index } = Route.useLoaderData()
  return <ExtensionsPage index={index} />
}
