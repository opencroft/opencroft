import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import { ReactFlowProvider } from '@xyflow/react'

import { CanvasNodesProvider } from '@/app/_authed/(dashboard)/_canvas/canvas-nodes-context'
import { SpaceCanvas } from '@/app/_authed/(space)/_components/space-canvas'
import { listSpaces, setActiveSpaceSlug } from '@/app/_authed/(space)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(space)/space/$slug')({
  loader: async ({ params }) => {
    const spaces = await listSpaces()
    if (spaces.length === 0) {
      throw redirect({ to: '/' })
    }
    const space = spaces.find((s) => s.slug === params.slug)
    if (!space) {
      throw notFound()
    }
    await setActiveSpaceSlug({ data: params.slug })
    return { space, spaces }
  },
  // The slug is the fallback because `head` also runs before the loader has
  // resolved, and the address always names the space even when nothing has
  // looked it up yet.
  head: ({ loaderData, params }) => ({
    meta: [{ title: pageTitle(loaderData?.space.name ?? params.slug) }],
  }),
  component: SpacePage,
})

function SpacePage() {
  const { slug } = Route.useParams()
  const { space } = Route.useLoaderData()
  return (
    <div className='h-full w-full'>
      <ReactFlowProvider>
        {/* Inside the provider, so tool views rendered anywhere below — the
            chat overlay included — can resolve node names. Surfaces without a
            canvas simply do not have it, and degrade to bare node ids. */}
        <CanvasNodesProvider>
          {/* No graph address: the space's page shows its DEFAULT graph. */}
          <SpaceCanvas slug={slug} spaceName={space.name} />
        </CanvasNodesProvider>
      </ReactFlowProvider>
    </div>
  )
}
