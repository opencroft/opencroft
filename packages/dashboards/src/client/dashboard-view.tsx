'use client'

import { Suspense, type ComponentType } from 'react'
import { Flex } from 'ui/layout/flex'
import { Spinner } from 'ui/utils/spinner'

interface Props {
  component?: ComponentType
}

// The dashboard component owns the whole pane — no page chrome is rendered
// above it. A dashboard's title/description are navigation labels (lists,
// sidebar, document title), not an on-page header.
//
// Suspense lives here rather than inside every extension: a dashboard
// component can be React.lazy(() => import(...)) wrapping a code-split
// extension chunk, and rendering one with no Suspense
// ancestor throws on its first render. A non-lazy component just renders
// through immediately — this is a no-op for every dashboard that doesn't
// opt in.
export function DashboardView({ component: Body }: Props) {
  return (
    <Flex expanded>
      {Body && (
        <Suspense
          fallback={
            <Flex expanded align='center' justify='center'>
              <Spinner className='size-5 text-muted-foreground' />
            </Flex>
          }
        >
          <Body />
        </Suspense>
      )}
    </Flex>
  )
}
