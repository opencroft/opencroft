import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/layout/scrollpage'

import { AddApp } from '@/app/_authed/(apps)/_components/add-app'
import { listApps } from '@/app/_authed/(apps)/_server/actions'
import { settleSpaceRoute } from '@/app/_authed/(space)/_lib/space-route'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'

// The add-app form — where a row of the settings' Add tab lands. Which App is
// being added rides in the `app` search param as its qualified type,
// `<owner>.<extension>.<type>`, which names one App on its own.
//
// THE SEGMENT IS `~add` RATHER THAN `add`, AND THE TILDE IS THE WHOLE POINT.
// This route is a static sibling of `$app`, which carries a user-minted
// instance slug — so the two share one namespace, and a static segment that a
// NAME COULD MINT is reachable by naming an app after it. The static route
// outranks the dynamic one, so that app's own settings link would open this
// form instead: no error, no 404, wrong screen. `add` was exactly that from the
// moment app addresses became slugs, and the comment that used to sit here
// argued the opposite ("instance ids are opaque and never the word add") on a
// premise slug routing deleted.
//
// The invariant, stated once: EVERY STATIC SIBLING OF A DYNAMIC SLUG SEGMENT
// MUST BE A STRING `instanceSlugFor` CANNOT PRODUCE. `slugify` collapses
// everything outside [a-z0-9] to `-` and trims the ends, so no name mints
// `~add`. This comment describes the rule; `_lib/static-route-segments.test.ts`
// enforces it across the whole route tree, so the next one is a failing build
// rather than someone finding it in the UI.
export const Route = createFileRoute('/_authed/(apps)/space_/$slug/settings_/app/~add')({
  validateSearch: (search: Record<string, unknown>): { app: string } => ({
    app: typeof search.app === 'string' ? search.app : '',
  }),
  // This loader wants nothing from the space itself, which is exactly why it
  // never noticed one that does not exist: it answered 200 and rendered the add
  // form for any slug at all. The space list is fetched to make the address mean
  // something.
  loader: async ({ params }) => {
    const { space, data: apps } = await settleSpaceRoute(params.slug, listSpaces(), listApps())
    return { space, apps }
  },
  head: ({ loaderData, params }) => ({
    meta: [{ title: pageTitle('Add app', loaderData?.space.name ?? params.slug) }],
  }),
  component: Page,
})

function Page() {
  const { apps } = Route.useLoaderData()
  const { slug } = Route.useParams()
  const { app } = Route.useSearch()
  const meta = apps.find((entry) => entry.type === app)
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
