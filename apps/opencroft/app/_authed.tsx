import { listPinnedDashboards } from '@opencroft/dashboards/server'
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'

import { AppShell } from '@/app/_shell/app-shell'
import { getAuthState } from '@/app/(auth)/_server/session'
import { listDashboards } from '@/app/_authed/(dashboards)/_server/actions'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'
import { SSEProvider } from '@/app/_authed/(sse)/_components/sse-provider'

// Path prefixes reachable only by an administrator. Checked here rather than
// per-route so a route added under one of these prefixes later is guarded by
// default. This is the UX redirect, not the security
// boundary: a `createServerFn` is a callable endpoint of its own regardless of
// which page links to it, so every admin-only server function checks
// `requireAdminUser` (packages/auth/server.ts) independently. Losing this list
// would show the wrong page; losing that check would let the action through.
const ADMIN_ONLY_PREFIXES = ['/settings/users', '/settings/tokens']

export const Route = createFileRoute('/_authed')({
  // The page-navigation gate. See __root.tsx for what this does NOT cover —
  // API routes are server handlers matched outside the router's route tree,
  // so this never runs for them.
  //
  // /login and /setup (app/(auth)/) are deliberately NOT children of this
  // route, so they never reach this beforeLoad at all — that structural
  // separation is the fix, not a path check inside the gate.
  // Before this route existed, __root.tsx owned both the gate and the chrome,
  // and /login was root's child, so it rendered inside AppShell: 24KB of
  // signed-out sidebar HTML plus this loader's data, shipped unauthenticated.
  beforeLoad: async ({ location }) => {
    const { needsSetup, signedIn, isAdmin } = await getAuthState()
    if (needsSetup) {
      // Nobody has set this instance up: there is no account to sign in with,
      // so the login form would be a dead end.
      throw redirect({ to: '/setup' })
    }
    if (!signedIn) {
      // Carry where they were headed so signing in resumes it rather than
      // dumping everyone on the root.
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    if (!isAdmin && ADMIN_ONLY_PREFIXES.some((prefix) => location.pathname.startsWith(prefix))) {
      throw redirect({ to: '/settings' })
    }
  },
  loader: async () => {
    const [spaces, dashboards, pinnedDashboardSlugs] = await Promise.all([
      listSpaces(),
      listDashboards(),
      listPinnedDashboards(),
    ])
    return { pinnedSpaces: spaces.filter((s) => s.pinned), dashboards, pinnedDashboardSlugs }
  },
  component: AuthedLayout,
})

function AuthedLayout() {
  const { pinnedSpaces, dashboards, pinnedDashboardSlugs } = Route.useLoaderData()
  return (
    <SSEProvider>
      <AppShell pinnedSpaces={pinnedSpaces} dashboards={dashboards} pinnedDashboardSlugs={pinnedDashboardSlugs}>
        <Outlet />
      </AppShell>
    </SSEProvider>
  )
}
