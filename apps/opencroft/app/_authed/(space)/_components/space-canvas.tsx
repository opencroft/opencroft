'use client'

import { FlowEditor } from '@/app/_authed/(dashboard)/_canvas/flow-editor'
import { OverlayProvider } from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import { ChatDock } from '@/app/_authed/(extension-runtime)/_client/chat-dock'
import { SelectionProvider } from '@/app/_authed/(extension-runtime)/_client/selection-context'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

/**
 * The thread slug every space surface addresses. One per member agent, chosen
 * in the chat's own picker -- so the full reference is
 * `{space-slug}.{agent}.main`.
 *
 * A constant rather than configuration: a space has ONE chat surface, and
 * letting anything pick the thread would let two surfaces in the same space
 * address different threads and look like the same conversation.
 */
const SPACE_THREAD_ID = 'main'

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
            its docked arrangements split the pair between them, and only
            something holding both can put them in that order. It stays inside
            the selection scope, which is what lets a node selected on the
            canvas reach the composer. The chat surface itself -- launcher,
            docks, floating window, mobile cover -- is the same ChatDock every
            extension gets from the host API. */}
        <ChatDock space={slug} id={SPACE_THREAD_ID} title={spaceName} chatName={spaceName}>
          <FlowEditor slug={slug} spaceName={spaceName} />
        </ChatDock>
      </OverlayProvider>
    </SelectionProvider>
  )
}
