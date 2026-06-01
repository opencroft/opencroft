import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router';

import { listSpaces } from '@/app/(space)/server/actions';
import { SSEProvider } from '@/app/(sse)/components/sse-provider';
import { AppShell } from '@/app/app-shell';
import appCss from '@/app/globals.css?url';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/ui/theme-provider';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'OpenCroft' },
      { name: 'description', content: 'Platform for your home lab' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  loader: async () => {
    const spaces = await listSpaces();
    return { pinnedSpaces: spaces.filter((s) => s.pinned) };
  },
  component: RootLayout,
});

function RootLayout() {
  const { pinnedSpaces } = Route.useLoaderData();
  return (
    <html lang='en' suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className='antialiased'>
        <ThemeProvider attribute='class' defaultTheme='system' enableSystem>
          <SSEProvider>
            <AppShell pinnedSpaces={pinnedSpaces}>
              <Outlet />
            </AppShell>
          </SSEProvider>
          <Toaster position='top-center' richColors />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
