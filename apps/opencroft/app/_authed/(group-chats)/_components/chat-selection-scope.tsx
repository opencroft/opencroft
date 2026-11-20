'use client'

import type { ReactNode } from 'react'

import { SelectionProvider, SelectionSpace } from '@/app/_authed/(extension-runtime)/_client/selection-context'

/**
 * The chats page's selection scope, for a space's own chat.
 *
 * Nothing on the chats page selects anything; the scope is there to show what
 * the browser's other windows select in the chat's space (the canvas, a
 * document), so a chat opened in a window of its own still quotes it. A chat
 * that is no space's has no space to take selections from, and gets no scope.
 *
 * Mounted by the chats page's routes and not inside the screens they render:
 * the same screens sit inside a space's chat dock, which already has the
 * surface's scope, and a second scope there would hide the surface's own
 * selection from its composer.
 */
export function ChatSelectionScope({ spaceId, children }: { spaceId: string | undefined; children: ReactNode }) {
  if (!spaceId) {
    return <>{children}</>
  }
  return (
    <SelectionSpace.Provider value={spaceId}>
      <SelectionProvider>{children}</SelectionProvider>
    </SelectionSpace.Provider>
  )
}
