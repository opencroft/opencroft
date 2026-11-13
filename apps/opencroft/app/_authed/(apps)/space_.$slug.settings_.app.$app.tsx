import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/layout/scrollpage'
import { TitleBarTitle } from 'ui/layouts/title-bar'

import { AppSettings } from '@/app/_authed/(apps)/_components/app-settings'
import { instanceBySlug } from '@/app/_authed/(apps)/_lib/instance-by-slug'
import { listApps, listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import { missingAddress, settleSpaceRoute } from '@/app/_authed/(space)/_lib/space-route'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'

// One App instance's settings — where the Apps list's Edit button lands.
// Standalone under /space/$slug/settings/app/$app rather than nested in
// the settings screen: the list is a section there, this is a full page of its
// own, and Back returns to that section.
export const Route = createFileRoute('/_authed/(apps)/space_/$slug/settings_/app/$app')({
  loader: async ({ params }) => {
    // An unknown SPACE is settled first (settleSpaceRoute); an unknown INSTANCE
    // in a space that exists is this loader's own check, below. Both leave for
    // the root (missingAddress).
    const { space, spaces, data } = await settleSpaceRoute(
      params.slug,
      listSpaces(),
      Promise.all([listApps(), listSpaceApps({ data: params.slug })]),
    )
    const [apps, instances] = data
    const instance = instanceBySlug(instances, params.app)
    if (!instance) {
      throw missingAddress()
    }
    const meta = apps.find((app) => app.type === instance.type)
    return { space, instance, meta, spaces }
  },
  head: ({ loaderData, params }) => ({
    meta: [
      {
        title: pageTitle('Settings', loaderData?.instance.name ?? params.app, loaderData?.space.name ?? params.slug),
      },
    ],
  }),
  component: Page,
})

function Page() {
  const { instance, meta, spaces } = Route.useLoaderData()
  const { slug } = Route.useParams()
  return (
    <ScrollPage>
      {/* On a phone the title bar names the page and leads with its Back. */}
      <TitleBarTitle>
        <span className='md:hidden'>{instance.name}</span>
      </TitleBarTitle>
      <ScrollHeader className='max-md:hidden'>
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
