import { listPinnedDashboards } from '@opencroft/dashboards/server'
import { createRootRoute, HeadContent, Outlet, redirect, Scripts } from '@tanstack/react-router'
import { Toaster } from 'ui/sonner'
import { ThemeProvider } from 'ui/theme-provider'

import { AppShell } from '@/app/_shell/app-shell'
import { getAuthState } from '@/app/(auth)/_server/session'
import { listDashboards } from '@/app/(dashboards)/_server/actions'
import { listSpaces } from '@/app/(space)/_server/actions'
import { SSEProvider } from '@/app/(sse)/_components/sse-provider'
import appCss from '@/app/globals.css?url'

// The auth screens themselves, which have to stay reachable without a session
// — /login is how you get one and /setup is how the first account exists at
// all. Each guards itself (see those routes); the guard below only needs to
// not send them in a circle.
const UNGUARDED_PATHS = new Set(['/login', '/setup'])

// ─────────────────────────────────────────────────────────────────────────────
// DO NOT REMOVE THE REVERSE PROXY'S BASIC AUTH. It is what protects everything
// this boundary does not.
//
// The gate below covers page navigation only. API routes are server handlers
// matched outside the router's route tree, so none of the following check for
// a session — any request that reaches the host reaches them:
//
//   /api/ws/terminal                shell access to the host
//   /api/mcp                        every agent tool call and node action
//   /api/auth/*                     the auth handler (necessarily open)
//   /api/ext/*                      extension assets, files and HTTP surfaces
//   /api/acp/*                      agent sessions, streams, skills
//   /api/spaces, /api/spaces/*      space read/write and export
//   /api/files/upload               file upload
//   /api/backup/*                   database backups
//   /api/sse, /api/build-info,
//   /api/yolo, /api/test-s3,
//   /api/route/$, /api/ext/action   remaining app and extension endpoints
//
// This is unchanged from before user accounts existed, and adding a login
// screen did not make it worse. What it did change is the reason people
// believe the proxy gate is needed: an instance that visibly asks for a
// password looks like it is protecting itself, and the obvious next move is to
// drop the "redundant" basic auth. Do that before the follow-up below lands and
// every route above is open to anyone who can reach the host — starting with a
// terminal.
//
// The follow-up is authenticating these surfaces in their own right, hardest
// first: /api/ws/terminal, then /api/mcp, then the rest. Until it has landed,
// the proxy gate is not redundant. It is the only thing there.
// ─────────────────────────────────────────────────────────────────────────────

export const Route = createRootRoute({
  // The boundary — see the block above for what it does NOT cover and what is
  // protecting that instead.
  //
  // Deliberately the only gate. Putting it here rather than on each route
  // means a route added later is guarded by default instead of by whoever
  // remembers to.
  beforeLoad: async ({ location }) => {
    if (UNGUARDED_PATHS.has(location.pathname)) {
      return
    }
    const { needsSetup, signedIn } = await getAuthState()
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
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'OpenCroft' },
      { name: 'description', content: 'Platform for your home lab' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    ],
  }),
  loader: async () => {
    const [spaces, dashboards, pinnedDashboardSlugs] = await Promise.all([
      listSpaces(),
      listDashboards(),
      listPinnedDashboards(),
    ])
    return { pinnedSpaces: spaces.filter((s) => s.pinned), dashboards, pinnedDashboardSlugs }
  },
  component: RootLayout,
})

function RootLayout() {
  const { pinnedSpaces, dashboards, pinnedDashboardSlugs } = Route.useLoaderData()
  return (
    <html lang='en' suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className='antialiased'>
        <ThemeProvider attribute='class' defaultTheme='system' enableSystem>
          <SSEProvider>
            <AppShell pinnedSpaces={pinnedSpaces} dashboards={dashboards} pinnedDashboardSlugs={pinnedDashboardSlugs}>
              <Outlet />
            </AppShell>
          </SSEProvider>
          <Toaster position='top-center' richColors />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  )
}
