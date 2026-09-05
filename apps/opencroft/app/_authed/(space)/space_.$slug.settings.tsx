import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/layout/scrollpage'

import { listApps, listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import { SpaceApps } from '@/app/_authed/(apps)/_components/space-apps'
import { SpaceIconSettings } from '@/app/_authed/(space)/_components/space-icon-settings'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'

export const Route = createFileRoute('/_authed/(space)/space_/$slug/settings')({
  loader: async ({ params }) => {
    const [spaces, apps, instances] = await Promise.all([
      listSpaces(),
      listApps(),
      listSpaceApps({ data: params.slug }),
    ])
    const space = spaces.find((s) => s.slug === params.slug)
    if (!space) {
      throw notFound()
    }
    return { space, apps, instances }
  },
  component: SpaceSettingsPage,
})

function SpaceSettingsPage() {
  const { space, apps, instances } = Route.useLoaderData()
  return (
    <ScrollPage>
      <ScrollHeader>
        <Flex row withGaps align='center' className='w-full'>
          <Link to='/spaces'>
            <Button variant='ghost' size='icon'>
              <ArrowLeft />
            </Button>
          </Link>
          <h1 className='text-lg font-semibold'>{space.name} — settings</h1>
        </Flex>
      </ScrollHeader>
      <ScrollContent className='p-4'>
        <Flex withGaps className='mx-auto w-full max-w-2xl gap-8'>
          <SpaceIconSettings spaceSlug={space.slug} initialIcon={space.icon} />
          <SpaceApps spaceSlug={space.slug} apps={apps} initialInstances={instances} />
        </Flex>
      </ScrollContent>
    </ScrollPage>
  )
}
