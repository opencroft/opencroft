'use client'

import { useLocation, useMatch } from '@tanstack/react-router'

import { appPathOf, isFullPageRoute } from '@/app/_authed/(apps)/_lib/app-routes'

/**
 * Whether the page on screen is one of an App's full-page routes, which the
 * host draws without its chrome. Answered from the App page's loader data,
 * which comes from the manifest, so it holds from the server render onwards
 * rather than once the App's bundle has loaded; off an App page, or while the
 * App page is still loading, the answer is no and the chrome stays.
 */
export function useFullPageAppRoute(): boolean {
  const match = useMatch({ from: '/_authed/(apps)/space_/$slug/app/$app', shouldThrow: false })
  const pathname = useLocation({ select: (location) => location.pathname })
  const data = match?.loaderData
  if (!match || !data) {
    return false
  }
  // The same base the App page hands the App's router, so this reads the path
  // exactly as the App does.
  const path = appPathOf(pathname, `/space/${match.params.slug}/app/${data.instance.slug}`)
  return path !== null && isFullPageRoute(data.fullPageRoutes, path)
}
