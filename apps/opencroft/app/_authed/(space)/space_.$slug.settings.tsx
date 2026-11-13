import { createFileRoute } from '@tanstack/react-router'
import { ChartColumn, LayoutGrid, SlidersHorizontal } from 'lucide-react'
import { TitleBarTitle } from 'ui/layouts/title-bar'
import { type SettingsSection, SettingsShell } from 'ui/settings/settings-shell'

import { SpaceApps } from '@/app/_authed/(apps)/_components/space-apps'
import { listApps, listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import { SpaceGeneralSettings } from '@/app/_authed/(space)/_components/space-general-settings'
import { SpaceUsageSettings } from '@/app/_authed/(space)/_components/space-usage-settings'
import { settleSpaceRoute } from '@/app/_authed/(space)/_lib/space-route'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'
import { pageTitle } from '@/app/_lib/page-title'
import { isSplitView } from '@/app/_shell/screen-stack'

export const Route = createFileRoute('/_authed/(space)/space_/$slug/settings')({
  // The page's whole UI state rides in the URL: which section is open, and —
  // within Apps — which tab. No section is the menu on a phone and General
  // from md up; the Installed tab is carried as absence. Every state is
  // linkable; an app's own settings page links back to ?section=apps this way.
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

// Categories in the kit's settings menu, as the instance settings have them:
// General (identity and the danger zone), Apps, and Usage today, with room
// for more.
const SECTIONS = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'apps', label: 'Apps', icon: LayoutGrid },
  { id: 'usage', label: 'Usage', icon: ChartColumn },
] as const satisfies readonly SettingsSection[]

type SectionId = (typeof SECTIONS)[number]['id']

function SpaceSettingsPage() {
  const { space, apps, instances } = Route.useLoaderData()
  const { section, tab = 'installed' } = Route.useSearch()
  const navigate = Route.useNavigate()
  const value = section ?? 'general'
  const label = SECTIONS.find((entry) => entry.id === value)?.label
  // Apart from the menu (a phone) a section is an entry over it, so Back
  // returns to the menu; beside it, choosing another replaces the entry, so
  // Back leaves the page. The whole search is replaced: a section's state
  // (the Apps tab) stays with it.
  const openSection = (id: string) => {
    if (id !== section) {
      navigate({ search: { section: id as SectionId }, replace: isSplitView() })
    }
  }
  // On a phone an open section is a screen of its own over the menu, named in
  // the title bar, whose Back returns to the menu (the shell's screen stack).
  return (
    <SettingsShell sections={[...SECTIONS]} value={value} onValueChange={openSection} isOpened={!!section}>
      <TitleBarTitle>
        {section ? (
          <>
            <span className='md:hidden'>{label}</span>
            <span className='max-md:hidden'>Settings</span>
          </>
        ) : (
          'Settings'
        )}
      </TitleBarTitle>
      <div className='mx-auto w-full max-w-4xl'>
        {value === 'general' ? (
          <SpaceGeneralSettings space={space} />
        ) : value === 'usage' ? (
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
    </SettingsShell>
  )
}
