'use client'

// How a group-chat control reloads what it just changed.
//
// The pins panel, the members dialog and the rename / topic / delete dialogs
// all end a successful write by asking the router to invalidate, which re-runs
// the group-chat route's loader and hands them fresh data. That is the right
// move on the group-chat screen and a no-op anywhere else: the embedded chat
// surface mounts the same controls inside a space canvas or an extension view,
// whose route loader knows nothing about the chat, so an invalidate there
// reloads the wrong thing and the panel keeps showing what it showed.
//
// So the refresh is a context. A host that loads the chat itself provides its
// own reload; with no provider the router's invalidate is what runs, which is
// exactly what every caller did before this existed.

import { useRouter } from '@tanstack/react-router'
import { createContext, type ReactNode, useCallback, useContext } from 'react'

const GroupChatRefreshContext = createContext<(() => Promise<void>) | null>(null)

export function GroupChatRefreshProvider({ refresh, children }: { refresh: () => Promise<void>; children: ReactNode }) {
  return <GroupChatRefreshContext.Provider value={refresh}>{children}</GroupChatRefreshContext.Provider>
}

/** Reload this group chat's data after a write — the host's own reload when it
 *  provided one, the route loader's invalidate otherwise. */
export function useGroupChatRefresh(): () => Promise<void> {
  const provided = useContext(GroupChatRefreshContext)
  const router = useRouter()
  const invalidate = useCallback(() => router.invalidate(), [router])
  return provided ?? invalidate
}
