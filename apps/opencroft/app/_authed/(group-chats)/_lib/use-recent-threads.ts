import { useEffect, useMemo } from 'react'

import { useFolderOpenCache } from '@/app/_authed/(group-chats)/_lib/folder-open-cache'
import { loadRecent, useHeldRecent } from '@/app/_authed/(group-chats)/_lib/recent-threads-store'
import { EMPTY_THREAD_LAYOUT } from '@/app/_authed/(group-chats)/_lib/thread-tree-layout'
import { type SaveLayout, useSavedLayout } from '@/app/_authed/(group-chats)/_lib/use-saved-layout'
import { saveRecentThreadLayout } from '@/app/_authed/(group-chats)/_server/actions'

// A refused save leaves the arrangement that won on screen, but its threads
// may be ones this tab has not resolved (another device added them), so
// Recent is read again too.
const saveRecent: SaveLayout = async (layout, expectedVersion) => {
  const result = await saveRecentThreadLayout({ data: { layout, expectedVersion } })
  if (!result.ok) {
    loadRecent().catch((error) => console.error('Failed to read Recent', error))
  }
  return result
}

/**
 * Recent as the chats page draws it: the person's arrangement of threads and
 * folders, saved like a chat's thread list (`useSavedLayout`), and each thread
 * in it as the server reads it now -- title, chat, agent, draft -- so a rename
 * shows and a thread the person can no longer open is gone.
 *
 * `refreshKey` reads it again when it changes: the page passes its own data,
 * which is read again after anything that can delete a thread. A change of
 * `openThreadId` reads it again too, so a draft written in or cleared from the
 * thread just left shows on its row.
 */
export function useRecentThreads(refreshKey: unknown, openThreadId: string | undefined) {
  const held = useHeldRecent()

  // biome-ignore lint/correctness/useExhaustiveDependencies(refreshKey): not read in the body; a change of it is the signal to read again
  // biome-ignore lint/correctness/useExhaustiveDependencies(openThreadId): not read in the body; a change of it is the signal to read again
  useEffect(() => {
    loadRecent().catch((error) => console.error('Failed to read Recent', error))
  }, [refreshKey, openThreadId])

  const loaded = useMemo(() => (held ? { layout: held.layout, version: held.version } : EMPTY_THREAD_LAYOUT), [held])
  // Keyed by the person, so another account signed in in this tab starts from
  // its own Recent rather than comparing versions with the last one's.
  const { layout, persist } = useSavedLayout(`recent:${held?.userId ?? ''}`, loaded, saveRecent)
  const { folderOpen, setFolderOpen } = useFolderOpenCache('recent')

  return { layout, threads: held?.threads ?? [], persist, folderOpen, setFolderOpen }
}
