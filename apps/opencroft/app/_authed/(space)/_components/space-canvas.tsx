'use client'

import { FlowEditor } from '@/app/_authed/(dashboard)/_canvas/flow-editor'
import { OverlayProvider } from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import { SelectionProvider } from '@/app/_authed/(extension-runtime)/_client/selection-context'
import { SpaceChatDock } from '@/app/_authed/(space)/_components/space-chat-dock'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

interface Props {
  slug: string
  spaces: SpaceSummary[]
}

export function SpaceCanvas({ slug, spaces }: Props) {
  const spaceName = spaces.find((s) => s.slug === slug)?.name ?? slug
  return (
    // The selection scope is mounted HERE rather than inside the editor,
    // because it is a property of this surface and not of the editor: the same
    // editor draws dashboards, where nothing is listening and no scope should
    // exist. What reads the selection is whatever chat this space shows -- the
    // scope has to enclose both, and this is the nearest place that does.
    <SelectionProvider>
      <OverlayProvider>
        {/* The chat ENCLOSES the editor rather than sitting after it, because
            where it docks is a property of the pair: it can take the left edge,
            the right, or the bottom, and only something holding both can put
            them in that order. It stays inside the selection scope, which is
            what lets a node selected on the canvas reach the composer. */}
        <SpaceChatDock slug={slug} spaceName={spaceName}>
          <FlowEditor slug={slug} spaceName={spaceName} />
        </SpaceChatDock>
      </OverlayProvider>
    </SelectionProvider>
  )
}
