import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/layout/scrollpage'

import { AddApp } from '@/app/_authed/(apps)/_components/add-app'
import { findAppByRef } from '@/app/_authed/(apps)/_lib/app-ref'
import { listApps } from '@/app/_authed/(apps)/_server/actions'

// The add-app form — where a row of the settings' Add tab lands. Which App is
// being added rides in the `app` search param as `<extension-slug>.<app-slug>`
// (see _lib/app-ref.ts). The static `add` segment outranks the sibling
// `$instanceId` route, so this page wins the address; instance ids are opaque
// and never the word "add".
export const Route = createFileRoute('/_authed/(apps)/space_/$slug/settings_/app/add')({
  validateSearch: (search: Record<string, unknown>): { app: string } => ({
    app: typeof search.app === 'string' ? search.app : '',
  }),
  loader: async () => ({ apps: await listApps() }),
  component: Page,
})

function Page() {
  const { apps } = Route.useLoaderData()
  const { slug } = Route.useParams()
  const { app } = Route.useSearch()
  const meta = findAppByRef(apps, app)
  return (
    <ScrollPage>
      <ScrollHeader>
        <Flex row withGaps align='center' className='w-full'>
          <Link to='/space/$slug/settings' params={{ slug }} search={{ section: 'apps' }}>
            <Button variant='ghost' size='icon'>
              <ArrowLeft />
            </Button>
          </Link>
          <h1 className='text-lg font-semibold'>{meta ? `Add ${meta.title}` : 'Add app'}</h1>
        </Flex>
      </ScrollHeader>
      <ScrollContent className='p-4'>
        <div className='mx-auto w-full max-w-4xl'>
          {meta ? (
            <AddApp spaceSlug={slug} app={meta} />
          ) : (
            <p className='text-sm text-muted-foreground'>This app is not available. It may have been removed.</p>
          )}
        </div>
      </ScrollContent>
    </ScrollPage>
  )
}
