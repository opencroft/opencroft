import { createRouter } from '@tanstack/react-router'

import { appBasePath } from '@/app/_authed/(apps)/_lib/app-routes'
import { routeTree } from '@/app/routeTree.gen'

export function getRouter() {
  const router = createRouter({
    routeTree,
    // Restored per history entry everywhere except at an App's addresses: an
    // App stays mounted while it moves between its pages and owns its scroll,
    // so the router neither restores nor resets it there. Restoring there
    // would put back positions the router snapshotted as the move began — the
    // page being left, not the one being returned to — over whatever the App
    // restored itself.
    scrollRestoration: ({ location }) => appBasePath(location.pathname) === null,
    defaultPreload: 'intent',
  })
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
