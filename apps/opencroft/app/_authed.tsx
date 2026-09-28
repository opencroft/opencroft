import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'

import { useFullPageAppRoute } from '@/app/_authed/(apps)/_components/full-page-route'
import { MarkdownResolversHost } from '@/app/_authed/(extension-runtime)/_client/markdown-resolvers'
import { listSpaces } from '@/app/_authed/(space)/_server/actions'
import { SSEProvider } from '@/app/_authed/(sse)/_components/sse-provider'
import { AppShell } from '@/app/_shell/app-shell'
import { getAuthState } from '@/app/(auth)/_server/session'

// Path prefixes reachable only by an administrator. Checked here rather than
// per-route so a route added under one of these prefixes later is guarded by
// default. This is the UX redirect, not the security
// boundary: a `createServerFn` is a callable endpoint of its own regardless of
// which page links to it, so every admin-only server function checks
// `requireAdminUser` (packages/auth/server.ts) independently. Losing this list
// would show the wrong page; losing that check would let the action through.
//
// `/settings/tokens` was here until token management moved into the Account
// screen. No such route exists any more, so the entry guarded
// nothing — and a guard covering a route that does not exist quietly reads as
// protection that is actually absent.
const ADMIN_ONLY_PREFIXES = ['/settings/users']

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
    // Handed down as route context so anything that shows or hides an
    // administrator-only affordance reads the SAME fact this redirect just
    // acted on, rather than asking again and risking a second answer. A menu
    // entry whose visibility drifted from the redirect would be an entry that
    // bounces whoever clicks it — worse than no entry at all. One call, one
    // truth, both consumers.
    return { isAdmin }
  },
  loader: async () => ({ spaces: await listSpaces() }),
  component: AuthedLayout,
})

function AuthedLayout() {
  const { spaces } = Route.useLoaderData()
  const fullPage = useFullPageAppRoute()
  return (
    <SSEProvider>
      <MarkdownResolversHost />
      <AppShell spaces={spaces} chrome={!fullPage}>
        <Outlet />
      </AppShell>
    </SSEProvider>
  )
}
