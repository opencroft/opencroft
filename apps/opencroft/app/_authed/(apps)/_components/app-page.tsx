'use client'

import type { AppDefinition } from '@opencroft/client'
import { Suspense } from 'react'
import { Flex } from 'ui/layout/flex'
import { Spinner } from 'ui/utils/spinner'

import { AppRouterProvider } from '@/app/_authed/(apps)/_components/app-router'
import type { SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/_authed/(extension-runtime)/_client/provides'

// The App's React component lives in the extension's client bundle, so it is
// resolved from the `apps` provider once extensions have loaded. Suspense
// lives here rather than inside every extension: an App's component can be
// React.lazy(() => import(...)) wrapping a code-split extension chunk, and
// rendering one with no Suspense ancestor throws on its first render. The
// component owns the whole pane; title/description are navigation labels.
export function AppPage({ spaceSlug, instance }: { spaceSlug: string; instance: SpaceAppInstance }) {
  const { items, loaded } = useProvided<AppDefinition>('apps', loadAllExtensions)
  const definition = items.find((entry) => entry.slug === instance.appSlug)
  const Body = definition?.component
  return (
    <Flex expanded className='min-h-0'>
      {Body ? (
        <Suspense
          fallback={
            <Flex expanded align='center' justify='center'>
              <Spinner className='size-5 text-muted-foreground' />
            </Flex>
          }
        >
          <AppRouterProvider base={`/space/${spaceSlug}/app/${instance.slug}`}>
            <Body instanceId={instance.id} spaceSlug={spaceSlug} params={instance.params} />
          </AppRouterProvider>
        </Suspense>
      ) : (
        loaded && (
          <Flex expanded align='center' justify='center'>
            <p className='text-sm text-muted-foreground'>This app has no client component.</p>
          </Flex>
        )
      )}
    </Flex>
  )
}
