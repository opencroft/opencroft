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
// THE ROUTES BELOW HAVE NO AUTHENTICATION OF THEIR OWN. What stands in front of
// them depends on the instance, so check yours rather than assuming:
//
//   behind proxy reverse-proxy basic auth. DO NOT REMOVE IT — it is the only
//                thing in front of every route listed below.
//   no proxy     NOTHING. If `proxyBasicAuth` is empty on the application node and
//                the instance answers on a public domain, so these routes are
//                open to anyone who finds the host, right now.
//
// An earlier version of this block said the proxy gate was "the only thing
// there" without qualifying it. That reads as reassurance on the instance where
// it is false, which is the internet-facing one.
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
// screen did not make it worse. What it did change is the reason people believe
// the proxy gate is needed: an instance that visibly asks for a password looks
// like it is protecting itself, and the obvious next move is to drop the
// "redundant" basic auth. On a public deployment, doing that before the follow-up lands
// opens every route above to anyone who can reach the host.
//
// The follow-up is authenticating these surfaces in their own right.
//
// ORDER, AND THE TRAP IN IT. The obvious order is highest-privilege first,
// which points at /api/ws/terminal because that is shell access. Acting on that
// is worse than doing nothing, because it produces a false sense of closure:
//
//   /api/ws/terminal is reached ONLY by packages/terminal's xterm client.
//   Agents never touch it. `remote_exec` arrives over /api/mcp, and remoteExec
//   resolves the core extension's terminal.exec and calls it IN-PROCESS.
//
// So gating the websocket closes the browser path to a shell and leaves the
// capability wide open behind an easier endpoint. SHELL ACCESS IS CLOSED WHEN
// /api/mcp IS CLOSED, AND NOT BEFORE. Gate the terminal route early if you
// like — it is cheap and blocks no agent — but do not record it as having
// protected shell access.
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
