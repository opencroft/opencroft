import { createFileRoute, Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { ArrowLeft } from 'lucide-react'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/layout/scrollpage'

import { SpaceApps } from '@/app/_authed/(apps)/_components/space-apps'
import { listApps, listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import { SpaceGeneralSettings } from '@/app/_authed/(space)/_components/space-general-settings'
import { SpaceUsageSettings } from '@/app/_authed/(space)/_components/space-usage-settings'
import { settleSpaceRoute } from '@/app/_authed/(space)/_lib/space-route'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(space)/space_/$slug/settings')({
  // The page's whole UI state rides in the URL: which section is open, and —
  // within Apps — which tab. Defaults (General, Installed) are carried as
  // absence, so the bare address stays clean and every state is linkable; an
  // app's own settings page links back to ?section=apps this way.
  validateSearch: (search: Record<string, unknown>): { section?: SectionId; tab?: 'add' } => ({
    section: SECTIONS.some((entry) => entry.id === search.section) ? (search.section as SectionId) : undefined,
    tab: search.tab === 'add' ? 'add' : undefined,
  }),
  loader: async ({ params }) => {
    // The space's existence is settled before the app data's rejection can
    // settle it — see settleSpaceRoute. Still one round of concurrent requests.
    const { space, data } = await settleSpaceRoute(
      params.slug,
      listSpaces(),
      Promise.all([listApps(), listSpaceApps({ data: params.slug })]),
    )
    const [apps, instances] = data
    return { space, apps, instances }
  },
  head: ({ loaderData, params }) => ({
    meta: [{ title: pageTitle('Settings', loaderData?.space.name ?? params.slug) }],
  }),
  component: SpaceSettingsPage,
})

// Categories in a panel down the LEFT, not tabs across the top: General
// (identity and the danger zone), Apps, and Usage today, with room for more.
const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'apps', label: 'Apps' },
  { id: 'usage', label: 'Usage' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

function SpaceSettingsPage() {
  const { space, apps, instances } = Route.useLoaderData()
  const { section = 'general', tab = 'installed' } = Route.useSearch()
  const navigate = Route.useNavigate()
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
        <div className='mx-auto flex w-full max-w-4xl gap-8'>
          <nav aria-label='Settings sections' className='w-44 shrink-0'>
            <Flex withGaps className='w-full gap-1'>
              {SECTIONS.map((entry) => (
                <Button
                  key={entry.id}
                  // The whole search is replaced: switching sections drops
                  // the other section's state (the Apps tab), and the
                  // default section is carried as no param at all.
                  render={
                    <Link
                      to='/space/$slug/settings'
                      params={{ slug: space.slug }}
                      search={entry.id === 'general' ? {} : { section: entry.id }}
                    />
                  }
                  nativeButton={false}
                  variant='ghost'
                  className={cn('w-full justify-start', section === entry.id && 'bg-muted font-medium')}
                >
                  {entry.label}
                </Button>
              ))}
            </Flex>
          </nav>
          <div className='min-w-0 flex-1'>
            {section === 'general' ? (
              <SpaceGeneralSettings space={space} />
            ) : section === 'usage' ? (
              <SpaceUsageSettings spaceSlug={space.slug} />
            ) : (
              <SpaceApps
                spaceSlug={space.slug}
                apps={apps}
                instances={instances}
                tab={tab}
                onTabChange={(next) =>
                  navigate({
                    search: (prev) => ({ ...prev, tab: next === 'add' ? 'add' : undefined }),
                    replace: true,
                  })
                }
              />
            )}
          </div>
        </div>
      </ScrollContent>
    </ScrollPage>
  )
}
