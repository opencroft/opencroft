import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import { ReactFlowProvider } from '@xyflow/react'

import { SpaceCanvas } from '@/app/(space)/_components/space-canvas'
import { listSpaces, setActiveSpaceSlug } from '@/app/(space)/_server/actions'

export const Route = createFileRoute('/(space)/space/$slug')({
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
    return { spaces }
  },
  component: SpacePage,
})

function SpacePage() {
  const { slug } = Route.useParams()
  const { spaces } = Route.useLoaderData()
  return (
    <div className='h-full w-full'>
      <ReactFlowProvider>
        <SpaceCanvas slug={slug} spaces={spaces} />
      </ReactFlowProvider>
    </div>
  )
}
