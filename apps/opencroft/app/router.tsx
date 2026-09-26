import { createRouter } from '@tanstack/react-router'

import { appBasePath } from '@/app/_authed/(apps)/_lib/app-routes'
import { routeTree } from '@/app/routeTree.gen'

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    // Restoration is keyed per history entry, except inside an App: all of
    // one App instance's pages share one key, so moving between them (back
    // and forward included) never puts the App's scrolled elements back
    // where an earlier entry left them. The App owns its scroll. The fallback
    // is the router's own default key, written out because the function that
    // holds it (defaultGetScrollRestorationKey) lives in @tanstack/router-core,
    // which react-router does not re-export and this app does not depend on.
    getScrollRestorationKey: (location) =>
      appBasePath(location.pathname) ?? (location.state.__TSR_key || location.href),
    defaultPreload: 'intent',
  })
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
