import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { Toaster } from 'ui/sonner'
import { ThemeProvider } from 'ui/theme-provider'

import appCss from '@/app/globals.css?url'

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
// The page-navigation gate lives in app/_authed.tsx, not here — this route is
// the document shell only (an earlier bug: /login rendered inside AppShell
// because this file used to own both the gate and the chrome, and /login was
// its child). It covers page navigation only. API routes are server handlers
// matched outside the router's route tree, so it never sees them — which is
// why each of the surfaces below needs its OWN check rather than one shared
// gate, and why the list below is split into what actually checks a session
// and what deliberately does not.
//
// SESSION-GATED (see @/app/_server/require-session.ts,
// applied per-handler in each of these files):
//
//   /api/acp/*                       agent sessions, streams, skills, tabs,
//                                    chat-list layout, the MCP server list
//   /api/spaces, /api/spaces/*       space read/write/export (not /route/$,
//                                    see below — a different thing entirely)
//   /api/files/upload                file upload
//   /api/backup/*                    database backup downloads
//   /api/sse, /api/yolo,
//   /api/test-s3                     dashboard toasts, yolo status, an S3
//                                    debug probe that actively deletes an
//                                    object on every GET — this one mattered
//   /api/ext/action                  no caller anywhere in this app or any
//                                    built-in extension, checked before
//                                    gating rather than assumed; gated anyway,
//                                    since an unauthenticated arbitrary-action
//                                    invoker costs nothing to close
//   /api/ext/<scope>/<slug>/<file>,
//   /api/ext/<scope>/<slug>/assets/* an extension's own compiled bundle and
//                                    static assets — loaded by a browser tab
//                                    that already has a session by the time
//                                    any extension UI renders
//
// STILL DELIBERATELY OPEN — not caution, a different question:
//
//   /api/mcp                        bearer-token surface,
//                                    not a session one. Session answers "is a
//                                    browser signed in"; this answers "does
//                                    this caller hold a credential we issued",
//                                    which is what an external MCP client and
//                                    an agent both need and neither has a
//                                    cookie for. SHELL ACCESS IS CLOSED WHEN
//                                    THIS IS, AND NOT BEFORE — still todo.
//   /api/auth/*                     the auth handler itself (necessarily open
//                                    — signing in is how a session is made)
//   /api/route/$                    a USER'S OWN "API Route" canvas node.
//                                    Gating this is not a gap, it would be a
//                                    regression: the entire feature is being a
//                                    webhook target for whatever external
//                                    caller its owner configured. Session-
//                                    gating it would mean no external service
//                                    could ever reach one again.
//   /api/ext/<scope>/<slug>/http/*   an extension's own declared HTTP handler.
//                                    Its own file says what it is for:
//                                    "proxies, webhooks, SSE all work" — same
//                                    reasoning as /api/route/$, one layer down.
//   /api/build-info                 branch + commit only, no secret, and the
//                                    one surface this whole night's work has
//                                    depended on as an unauthenticated
//                                    liveness/deploy-verification signal.
//                                    Left open as a deliberate, named tradeoff
//                                    rather than gated by default — revisit if
//                                    that stops being the right call, but do
//                                    not gate it by accident.
//
// This is unchanged from before user accounts existed for the surfaces still
// open, and adding a login screen did not make those worse. What it did
// change is the reason people believe the proxy gate is needed: an instance
// that visibly asks for a password looks like it is protecting itself, and
// the obvious next move is to drop the "redundant" basic auth. On a public deployment,
// doing that before every surface above is accounted for opens whatever is
// still open to anyone who can reach the host.
//
// /api/ws/terminal IS DONE — it now requires the same cookie session as any
// page (see server/routes/api/ws/terminal.ts), which is why it does not
// appear above at all. Read what that does and does not buy before assuming
// the job is finished:
//
// ORDER, AND THE TRAP IN IT. The obvious order was highest-privilege first,
// which points at /api/ws/terminal because that is shell access. Acting on
// that alone would have been worse than doing nothing, because it produces a
// false sense of closure:
//
//   /api/ws/terminal is reached ONLY by packages/terminal's xterm client.
//   Agents never touch it. `remote_exec` arrives over /api/mcp, and remoteExec
//   resolves the core extension's terminal.exec and calls it IN-PROCESS.
//
// So gating the websocket closed the BROWSER path to a shell and left the
// capability wide open behind an easier endpoint. SHELL ACCESS IS CLOSED WHEN
// /api/mcp IS CLOSED, AND NOT BEFORE — that is still todo, is the harder half,
// and is tracked separately. Do not read the terminal gate as having protected
// shell access.
// ─────────────────────────────────────────────────────────────────────────────

export const Route = createRootRoute({
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
  component: RootDocument,
})

function RootDocument() {
  return (
    <html lang='en' suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className='antialiased'>
        <ThemeProvider attribute='class' defaultTheme='system' enableSystem>
          <Outlet />
          <Toaster position='top-center' richColors />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  )
}
