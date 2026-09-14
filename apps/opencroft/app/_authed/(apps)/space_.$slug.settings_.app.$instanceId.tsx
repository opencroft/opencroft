import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/layout/scrollpage'

import { AppSettings } from '@/app/_authed/(apps)/_components/app-settings'
import { listApps, listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import { settleSpaceRoute } from '@/app/_authed/(space)/_lib/space-route'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'

// One App instance's settings — where the Apps list's Edit button lands.
// Standalone under /space/$slug/settings/app/$instanceId rather than nested in
// the settings screen: the list is a section there, this is a full page of its
// own, and Back returns to that section.
export const Route = createFileRoute('/_authed/(apps)/space_/$slug/settings_/app/$instanceId')({
  loader: async ({ params }) => {
    // An unknown SPACE is settled first (settleSpaceRoute); an unknown INSTANCE
    // in a space that exists is this loader's own notFound, below. Both 404.
    const { spaces, data } = await settleSpaceRoute(
      params.slug,
      listSpaces(),
      Promise.all([listApps(), listSpaceApps({ data: params.slug })]),
    )
    const [apps, instances] = data
    const instance = instances.find((entry) => entry.id === params.instanceId)
    if (!instance) {
      throw notFound()
    }
    const meta = apps.find((app) => app.extensionId === instance.extensionId && app.slug === instance.appSlug)
    return { instance, meta, spaces }
  },
  component: Page,
})

function Page() {
  const { instance, meta, spaces } = Route.useLoaderData()
  const { slug } = Route.useParams()
  return (
    <ScrollPage>
      <ScrollHeader>
        <Flex row withGaps align='center' className='w-full'>
          <Link to='/space/$slug/settings' params={{ slug }} search={{ section: 'apps' }}>
            <Button variant='ghost' size='icon'>
              <ArrowLeft />
            </Button>
          </Link>
          <h1 className='text-lg font-semibold'>{instance.name} — settings</h1>
        </Flex>
      </ScrollHeader>
      <ScrollContent className='p-4'>
        <div className='mx-auto w-full max-w-4xl'>
          <AppSettings spaceSlug={slug} instance={instance} meta={meta} spaces={spaces} />
        </div>
      </ScrollContent>
    </ScrollPage>
  )
}
