'use client'

import { FlowEditor } from '@/app/_authed/(dashboard)/_canvas/flow-editor'
import { OverlayProvider } from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

interface Props {
  slug: string
  spaces: SpaceSummary[]
}

export function SpaceCanvas({ slug, spaces }: Props) {
  const spaceName = spaces.find((s) => s.slug === slug)?.name ?? slug
  return (
    <OverlayProvider>
      <FlowEditor slug={slug} spaceName={spaceName} />
    </OverlayProvider>
  )
}
