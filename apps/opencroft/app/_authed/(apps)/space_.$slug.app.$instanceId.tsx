import { createFileRoute, notFound } from '@tanstack/react-router'

import { AppPage } from '@/app/_authed/(apps)/_components/app-page'
import { listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import { settleSpaceRoute } from '@/app/_authed/(space)/_lib/space-route'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'

export const Route = createFileRoute('/_authed/(apps)/space_/$slug/app/$instanceId')({
  loader: async ({ params }) => {
    // The space list is fetched purely to settle whether the SPACE exists —
    // without it this loader's only signal is listSpaceApps' `Unknown space`
    // rejection, which reaches the crash page instead of a 404.
    const { data: instances } = await settleSpaceRoute(params.slug, listSpaces(), listSpaceApps({ data: params.slug }))
    const instance = instances.find((entry) => entry.id === params.instanceId)
    if (!instance) {
      throw notFound()
    }
    return { instance }
  },
  component: Page,
})

function Page() {
  const { instance } = Route.useLoaderData()
  const { slug } = Route.useParams()
  return <AppPage spaceSlug={slug} instance={instance} />
}
