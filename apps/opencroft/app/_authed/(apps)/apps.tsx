import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AppLauncherScreen } from 'ui/layouts/app-launcher'

import { leaveAppsPage } from '@/app/_authed/(apps)/_lib/leave-apps-page'
import { pageTitle } from '@/app/_lib/page-title'
import { useAppLauncher } from '@/app/_shell/app-launcher-host'

// The App Launcher as a page: where a phone goes to switch apps, from the bottom
// navigation or the title bar. A desktop opens the same search over the page
// with Cmd+K.
//
// `space` is the space of what the reader opened from here. The page writes it
// into its own history entry as they leave, so Back to it opens on that space;
// a visit by any other way has none and opens on Recent.
export const Route = createFileRoute('/_authed/(apps)/apps')({
  validateSearch: (search: Record<string, unknown>): { space?: string } => ({
    space: typeof search.space === 'string' && search.space !== '' ? search.space : undefined,
  }),
  head: () => ({ meta: [{ title: pageTitle('Apps') }] }),
  component: AppsPage,
})

function AppsPage() {
  const router = useRouter()
  const { space } = Route.useSearch()
  // Read once, as the page opens: the entry is rewritten as the reader leaves,
  // and the screen they leave stays as they saw it.
  const [cameFrom] = useState(space)
  const { search, refresh } = useAppLauncher()
  // Every visit lists the apps as they are now.
  useEffect(() => {
    refresh()
  }, [refresh])

  function spaceOf(href: string) {
    return (
      search.apps.find((app) => app.href === href)?.spaceSlug ??
      search.spaces.find((each) => search.hrefFor(each.slug) === href)?.slug
    )
  }

  function navigate(href: string) {
    const next = spaceOf(href)
    if (next === space) {
      router.history.push(href)
    } else {
      leaveAppsPage(router.history, router.buildLocation({ to: '/apps', search: { space: next } }).href, href)
    }
  }

  // A space removed since opens on Recent, as a fresh visit does.
  const opensOnSpace = search.spaces.some((each) => each.slug === cameFrom) ? cameFrom : undefined

  return (
    <AppLauncherScreen
      {...search}
      opensOn={opensOnSpace ? 'space' : 'recent'}
      currentSlug={opensOnSpace ?? search.currentSlug}
      onNavigate={navigate}
    />
  )
}
