'use client'

import { Link, useLocation } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from 'ui/sidebar'

import { listApps, listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import type { AppMeta, SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'

/**
 * The current space's App instances as sidebar entries. Refetched on every
 * navigation (not just when the space changes) so an instance added on the
 * settings page shows up as soon as the user goes anywhere else.
 */
export function SidebarApps({ spaceSlug }: { spaceSlug: string }) {
  const pathname = useLocation({ select: (l) => l.pathname })
  const [instances, setInstances] = useState<SpaceAppInstance[]>([])
  const [apps, setApps] = useState<AppMeta[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all([listSpaceApps({ data: spaceSlug }), listApps()])
      .then(([nextInstances, nextApps]) => {
        if (!cancelled) {
          setInstances(nextInstances)
          setApps(nextApps)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInstances([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [spaceSlug, pathname])

  if (instances.length === 0) {
    return null
  }

  return (
    <SidebarMenuSub>
      {instances.map((instance) => {
        const meta = apps.find((app) => app.extensionId === instance.extensionId && app.slug === instance.appSlug)
        const Icon = resolveIcon(meta?.icon)
        const label = instance.name || meta?.title || instance.appSlug
        return (
          <SidebarMenuSubItem key={instance.id}>
            <SidebarMenuSubButton
              render={<Link to='/space/$slug/app/$app' params={{ slug: spaceSlug, app: instance.slug }} />}
              isActive={pathname === `/space/${spaceSlug}/app/${instance.slug}`}
            >
              <Icon />
              <span>{label}</span>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        )
      })}
    </SidebarMenuSub>
  )
}
