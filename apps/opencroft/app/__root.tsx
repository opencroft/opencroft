import { listPinnedDashboards } from '@opencroft/dashboards/server'
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { Toaster } from 'ui/sonner'
import { ThemeProvider } from 'ui/theme-provider'

import { AppShell } from '@/app/_shell/app-shell'
import { listDashboards } from '@/app/(dashboards)/_server/actions'
import { listSpaces } from '@/app/(space)/_server/actions'
import { SSEProvider } from '@/app/(sse)/_components/sse-provider'
import appCss from '@/app/globals.css?url'

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
