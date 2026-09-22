import { createFileRoute, notFound } from '@tanstack/react-router'

import { AppPage } from '@/app/_authed/(apps)/_components/app-page'
import { instanceBySlug } from '@/app/_authed/(apps)/_lib/instance-by-slug'
import { listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import { settleSpaceRoute } from '@/app/_authed/(space)/_lib/space-route'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(apps)/space_/$slug/app/$app')({
  loader: async ({ params }) => {
    // The space list is fetched purely to settle whether the SPACE exists —
    // without it this loader's only signal is listSpaceApps' `Unknown space`
    // rejection, which reaches the crash page instead of a 404.
    // It is also where the title gets the space's NAME: the check already
    // resolved the row, so naming it costs nothing beyond returning it.
    const { space, data: instances } = await settleSpaceRoute(
      params.slug,
      listSpaces(),
      listSpaceApps({ data: params.slug }),
    )
    const instance = instanceBySlug(instances, params.app)
    if (!instance) {
      throw notFound()
    }
    return { space, instance }
  },
  // Both slugs are the fallback: `head` also runs before the loader resolves,
  // and the address names the app and the space even then.
  head: ({ loaderData, params }) => ({
    meta: [{ title: pageTitle(loaderData?.instance.name ?? params.app, loaderData?.space.name ?? params.slug) }],
  }),
  component: Page,
})

function Page() {
  const { instance } = Route.useLoaderData()
  const { slug } = Route.useParams()
  return <AppPage spaceSlug={slug} instance={instance} />
}
