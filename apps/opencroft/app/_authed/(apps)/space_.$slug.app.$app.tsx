import { createFileRoute } from '@tanstack/react-router'

import { AppPage } from '@/app/_authed/(apps)/_components/app-page'
import { instanceBySlug } from '@/app/_authed/(apps)/_lib/instance-by-slug'
import { appFullPageRoutes, listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import { SelectionProvider, SelectionSpace } from '@/app/_authed/(extension-runtime)/_client/selection-context'
import { missingAddress, settleSpaceRoute } from '@/app/_authed/(space)/_lib/space-route'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(apps)/space_/$slug/app/$app')({
  loader: async ({ params }) => {
    // The space list is fetched purely to settle whether the SPACE exists —
    // without it this loader's only signal is listSpaceApps' `Unknown space`
    // rejection, which reaches the crash page instead of the root.
    // It is also where the title gets the space's NAME: the check already
    // resolved the row, so naming it costs nothing beyond returning it.
    const { space, data: instances } = await settleSpaceRoute(
      params.slug,
      listSpaces(),
      listSpaceApps({ data: params.slug }),
    )
    const instance = instanceBySlug(instances, params.app)
    if (!instance) {
      throw missingAddress()
    }
    // Which of the App's pages draw without the host's chrome. Loaded here,
    // from the manifest, so the shell knows before the App's own bundle does
    // and the first paint of such a page is already bare.
    const fullPageRoutes = await appFullPageRoutes({ data: { type: instance.type } })
    return { space, instance, fullPageRoutes }
  },
  // Both slugs are the fallback: `head` also runs before the loader resolves,
  // and the address names the app and the space even then.
  head: ({ loaderData, params }) => ({
    meta: [{ title: pageTitle(loaderData?.instance.name ?? params.app, loaderData?.space.name ?? params.slug) }],
  }),
  component: Page,
})

function Page() {
  const { space, instance } = Route.useLoaderData()
  const { slug } = Route.useParams()
  // Every App page has a selection scope, mounted here so no App has to mount
  // its own: what its surfaces publish is quoted as `Space › App › what`, and
  // reaches this space's chats in the browser's other windows.
  return (
    <SelectionSpace.Provider value={space.id}>
      <SelectionProvider spaceName={space.name} place={instance.name}>
        <AppPage spaceSlug={slug} instance={instance} />
      </SelectionProvider>
    </SelectionSpace.Provider>
  )
}
