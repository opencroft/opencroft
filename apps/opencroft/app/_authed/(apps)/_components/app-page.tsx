'use client'

import type { AppDefinition } from '@opencroft/client'
import { Suspense } from 'react'
import { Flex } from 'ui/layout/flex'
import { LogoLoader } from 'ui/logo-loader'

import { AppRouterProvider } from '@/app/_authed/(apps)/_components/app-router'
import type { SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import { InstallMissingExtension, missingTypeLabel } from '@/app/_authed/(extension-runtime)/_client/missing-extension'
import { useProvided } from '@/app/_authed/(extension-runtime)/_client/provides'

// The App's React component lives in the extension's client bundle, so it is
// resolved from the `apps` provider once extensions have loaded. Suspense
// lives here rather than inside every extension: an App's component can be
// React.lazy(() => import(...)) wrapping a code-split extension chunk, and
// rendering one with no Suspense ancestor throws on its first render. The
// component owns the whole pane; title/description are navigation labels.
//
// The pane is also the App's overflow boundary. The App's root gets exactly
// the pane's width, but a fixed-width child -- an SVG with `width="720"`, a
// wide table -- spills past that root as visible overflow, and nothing above
// the pane stops it before the document: the whole page, title bar included,
// would scroll sideways on a narrow screen. Ending it here keeps the host's
// chrome still and the content reachable. An App that fills the pane never
// overflows it and never sees this scrollbar; one that wants a wide element
// to scroll on its own puts the scroll on that element.
export function AppPage({ spaceSlug, instance }: { spaceSlug: string; instance: SpaceAppInstance }) {
  const { items, loaded } = useProvided<AppDefinition>('apps', loadAllExtensions)
  const definition = items.find((entry) => entry.type === instance.type)
  const Body = definition?.component
  if (!instance.provided) {
    return (
      <Flex expanded align='center' justify='center' className='gap-2'>
        <p className='text-sm text-muted-foreground'>{missingTypeLabel(instance.type)}</p>
        <InstallMissingExtension type={instance.type} />
      </Flex>
    )
  }
  return (
    <Flex expanded className='min-h-0 overflow-auto'>
      {Body ? (
        <Suspense fallback={<AppLoading />}>
          <AppRouterProvider base={`/space/${spaceSlug}/app/${instance.slug}`}>
            <Body instanceId={instance.id} spaceSlug={spaceSlug} params={instance.params} />
          </AppRouterProvider>
        </Suspense>
      ) : loaded ? (
        <Flex expanded align='center' justify='center'>
          <p className='text-sm text-muted-foreground'>This app has no client component.</p>
        </Flex>
      ) : (
        <AppLoading />
      )}
    </Flex>
  )
}

// The host's two waits, extensions loading and then the App's chunk, run back
// to back, so they are one component and read as a single wait.
function AppLoading() {
  return (
    <Flex expanded align='center' justify='center'>
      <LogoLoader size={40} className='text-foreground' aria-label='Loading app' />
    </Flex>
  )
}
