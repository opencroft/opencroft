'use client'

import { useLocation } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { AppLauncherApp } from 'ui/layouts/app-launcher'

import { appBasePath } from '@/app/_authed/(apps)/_lib/app-routes'
import { listApps, listSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import type { AppMeta, SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'
import { DEFAULT_GRAPH_SLUG, GRAPH_APP_TYPE } from '@/app/_authed/(space)/_server/types'

/**
 * The space the reader is in: the one in the address, and only that. Off a
 * space's own pages there is none — the chrome shows no current space rather
 * than one somebody else last opened.
 */
function slugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/space\/([^/]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

type InstanceAddress = Pick<SpaceAppInstance, 'id' | 'type' | 'name' | 'slug'>

/** An app of the space the chrome is in; the launcher's apps add which space. */
export type SpaceApp = Omit<AppLauncherApp, 'spaceSlug'>

function isDefaultGraph(instance: InstanceAddress) {
  return instance.type === GRAPH_APP_TYPE && instance.slug === DEFAULT_GRAPH_SLUG
}

/**
 * An app of a space as the chrome lists it: its name, its icon and kind from
 * the App's manifest, and its address. The space's default graph is addressed
 * by the space itself, which is where the space's own link goes.
 */
export function toSpaceApp(spaceSlug: string, instance: InstanceAddress, apps: AppMeta[]): SpaceApp {
  const meta = apps.find((app) => app.type === instance.type)
  return {
    id: instance.id,
    label: instance.name || meta?.title || instance.type,
    href: isDefaultGraph(instance) ? `/space/${spaceSlug}` : `/space/${spaceSlug}/app/${instance.slug}`,
    icon: resolveIcon(meta?.icon),
    type: meta?.title ?? instance.type,
  }
}

/**
 * The space's App instances, as the chrome lists them. The space's graphs
 * are instances too, so they arrive here with the rest. Refetched on every navigation, not only when the space changes, so an
 * instance added in the settings shows up as soon as the reader goes anywhere.
 * Moving between one App's own pages is not going anywhere: the App is the
 * page, so those moves share one trigger and fetch nothing.
 */
function useSpaceApps(slug: string | null, pathname: string): SpaceApp[] {
  const [instances, setInstances] = useState<SpaceAppInstance[]>([])
  const [apps, setApps] = useState<AppMeta[]>([])
  const page = appBasePath(pathname) ?? pathname

  // biome-ignore lint/correctness/useExhaustiveDependencies: page is the refetch trigger, see above
  useEffect(() => {
    if (!slug) {
      return
    }
    let cancelled = false
    Promise.all([listSpaceApps({ data: slug }), listApps()])
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
  }, [slug, page])

  if (!slug) {
    return []
  }
  return instances.map((instance) => toSpaceApp(slug, instance, apps))
}

export interface SpaceNavigation {
  pathname: string
  /** The space in the address; null off a space's pages. */
  slug: string | null
  /** The space's apps, its default graph among them; empty off a space's pages. */
  apps: SpaceApp[]
  /** The app the address is in, if any. */
  activeAppId: string | undefined
}

/**
 * Where the reader is among spaces and their apps, read once by the shell
 * for every piece of chrome that shows it, so the title bar and the bottom
 * navigation fetch the apps once and agree on which one is open.
 */
export function useSpaceNavigation(): SpaceNavigation {
  const pathname = useLocation({ select: (l) => l.pathname })
  const slug = slugFromPath(pathname)
  const apps = useSpaceApps(slug, pathname)

  // The default graph answers at the space's own address and at its app
  // address alike; every other app only at its own.
  const spaceHref = `/space/${slug}`
  const defaultGraphAppHref = `${spaceHref}/app/${DEFAULT_GRAPH_SLUG}`
  const onSpaceCanvas =
    slug !== null &&
    (pathname === spaceHref || pathname === defaultGraphAppHref || pathname.startsWith(`${defaultGraphAppHref}/`))
  const activeAppId = apps.find((app) =>
    app.href === spaceHref ? onSpaceCanvas : pathname === app.href || pathname.startsWith(`${app.href}/`),
  )?.id

  return { pathname, slug, apps, activeAppId }
}
