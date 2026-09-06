import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/layout/scrollpage'
import { cn } from 'ui/lib/utils'

import { SpaceApps } from '@/app/_authed/(apps)/_components/space-apps'
import { listApps, listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import { SpaceGeneralSettings } from '@/app/_authed/(space)/_components/space-general-settings'
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
    return { space, apps, instances, spaces }
  },
  component: SpaceSettingsPage,
})

// Categories in a panel down the LEFT, not tabs across the top: General
// (identity and the danger zone) and Apps today, with room for more.
const SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'apps', label: 'Apps' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

function SpaceSettingsPage() {
  const { space, apps, instances, spaces } = Route.useLoaderData()
  const [section, setSection] = useState<SectionId>('general')
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
                  variant='ghost'
                  onClick={() => setSection(entry.id)}
                  className={cn('w-full justify-start', section === entry.id && 'bg-muted font-medium')}
                >
                  {entry.label}
                </Button>
              ))}
            </Flex>
          </nav>
          <div className='min-w-0 flex-1'>
            {section === 'general' ? (
              <SpaceGeneralSettings space={space} spaces={spaces} />
            ) : (
              <SpaceApps spaceSlug={space.slug} apps={apps} initialInstances={instances} />
            )}
          </div>
        </div>
      </ScrollContent>
    </ScrollPage>
  )
}
