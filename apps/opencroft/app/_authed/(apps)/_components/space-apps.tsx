'use client'

import { Link } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { Button } from 'ui/button'
import { Input } from 'ui/input'
import { Flex } from 'ui/layout/flex'
import { Tabs, TabsContent, TabsList, TabsTrigger } from 'ui/tabs'

import { appRefFor } from '@/app/_authed/(apps)/_lib/app-ref'
import type { AppMeta, SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'

interface Props {
  spaceSlug: string
  /** Every App extensions provide, from the manifests. */
  apps: AppMeta[]
  instances: SpaceAppInstance[]
  /** Which tab is showing. Owned by the caller — it lives in the settings page's URL. */
  tab: 'installed' | 'add'
  onTabChange: (tab: 'installed' | 'add') => void
}

/** "label: value" for each declared parameter the instance has a value for. */
function paramsSummary(instance: SpaceAppInstance, meta: AppMeta | undefined): string {
  return (meta?.parameters ?? [])
    .filter((spec) => instance.params[spec.id])
    .map((spec) => `${spec.label}: ${instance.params[spec.id]}`)
    .join(' · ')
}

/**
 * The Apps section of a space's settings, in two tabs: the installed
 * instances — each row opening the instance's settings page (name,
 * parameters, transfer, removal) and carrying one affordance that opens the
 * App itself in a new tab — and the searchable catalog to add from, whose
 * rows lead to the add-app form page.
 */
export function SpaceApps({ spaceSlug, apps, instances, tab, onTabChange }: Props) {
  const [search, setSearch] = useState('')

  const query = search.trim().toLowerCase()
  const catalog = query
    ? apps.filter((app) =>
        [app.title, app.description ?? '', app.slug].some((text) => text.toLowerCase().includes(query)),
      )
    : apps

  return (
    <Flex withGaps className='w-full'>
      <h2 className='text-base font-semibold'>Apps</h2>

      <Tabs value={tab} onValueChange={(next) => onTabChange(next as 'installed' | 'add')} className='w-full'>
        <TabsList>
          <TabsTrigger value='installed'>Installed</TabsTrigger>
          <TabsTrigger value='add'>Add</TabsTrigger>
        </TabsList>

        <TabsContent value='installed'>
          {instances.length === 0 ? (
            <p className='text-sm text-muted-foreground'>No apps added yet.</p>
          ) : (
            <Flex withGaps className='w-full'>
              {instances.map((instance) => {
                const meta = apps.find(
                  (app) => app.extensionId === instance.extensionId && app.slug === instance.appSlug,
                )
                const Icon = resolveIcon(meta?.icon)
                const summary = paramsSummary(instance, meta)
                const subtitle = [meta?.title ?? instance.appSlug, summary].filter(Boolean).join(' · ')
                return (
                  <Flex key={instance.id} row withGaps align='center' className='w-full rounded-md border p-3'>
                    <Link
                      to='/space/$slug/settings/app/$instanceId'
                      params={{ slug: spaceSlug, instanceId: instance.id }}
                      className='flex min-w-0 flex-1 items-center gap-3 hover:opacity-80'
                    >
                      <Icon className='size-5 shrink-0 text-muted-foreground' />
                      <Flex className='min-w-0 flex-1'>
                        <span className='font-medium'>{instance.name}</span>
                        <span className='truncate text-xs text-muted-foreground'>{subtitle}</span>
                      </Flex>
                    </Link>
                    {/* The row's ONE action: the App itself, in a new tab, so
                        the icon is literal and the settings this row leads to
                        stay open behind it. The target is what carries that:
                        a link only routes in place while its target is absent
                        or _self, so setting it hands the click back to the
                        browser. Current browsers imply `noopener` for a
                        `_blank` target; writing it out beside `noreferrer`
                        states the intent in one place and costs nothing.
                        The accessible name carries the new tab too, because
                        the icon only announces it to people who can see it;
                        the visible tooltip stays the short form. */}
                    <Button asChild variant='ghost' size='icon' aria-label='Open in a new tab' title='Open'>
                      <Link
                        to='/space/$slug/app/$instanceId'
                        params={{ slug: spaceSlug, instanceId: instance.id }}
                        target='_blank'
                        rel='noopener noreferrer'
                      >
                        <ExternalLink />
                      </Link>
                    </Button>
                  </Flex>
                )
              })}
            </Flex>
          )}
        </TabsContent>

        <TabsContent value='add'>
          <Flex withGaps className='w-full'>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder='Search apps…' />
            {catalog.length === 0 ? (
              <p className='text-sm text-muted-foreground'>
                {apps.length === 0 ? 'No apps available.' : 'No apps match the search.'}
              </p>
            ) : (
              catalog.map((app) => {
                const Icon = resolveIcon(app.icon)
                return (
                  <Link
                    key={`${app.extensionId}/${app.slug}`}
                    to='/space/$slug/settings/app/add'
                    params={{ slug: spaceSlug }}
                    search={{ app: appRefFor(app) }}
                    className='flex w-full items-center gap-3 rounded-md border p-3 text-left hover:bg-accent'
                  >
                    <Icon className='size-5 shrink-0 text-muted-foreground' />
                    <Flex className='min-w-0 flex-1'>
                      <span className='font-medium'>{app.title}</span>
                      {app.description && (
                        <span className='truncate text-xs text-muted-foreground'>{app.description}</span>
                      )}
                    </Flex>
                  </Link>
                )
              })
            )}
          </Flex>
        </TabsContent>
      </Tabs>
    </Flex>
  )
}
