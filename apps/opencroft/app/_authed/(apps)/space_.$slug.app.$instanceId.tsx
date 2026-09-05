import { createFileRoute, notFound } from '@tanstack/react-router'

import { AppPage } from '@/app/_authed/(apps)/_components/app-page'
import { listSpaceApps } from '@/app/_authed/(apps)/_server/actions'

export const Route = createFileRoute('/_authed/(apps)/space_/$slug/app/$instanceId')({
  loader: async ({ params }) => {
    const instances = await listSpaceApps({ data: params.slug })
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
