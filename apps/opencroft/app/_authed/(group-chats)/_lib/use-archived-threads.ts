'use client'

// A group chat's archived threads, read only while something draws them.
//
// A chat opens on its active list. The archive can be many times longer and is
// seen only in two places -- the settings dialog's Archive section and a
// search widened to the archive -- so it is not part of what a chat loads.
// Each of those asks for it here, while it is showing.

import { useEffect, useState } from 'react'

import type { GroupChatThreadListEntry } from '@/app/_authed/(group-chats)/_server/actions'
import { listGroupChatThreadsView } from '@/app/_authed/(group-chats)/_server/actions'

export type ArchivedThreads =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; threads: GroupChatThreadListEntry[] }

const LOADING: ArchivedThreads = { state: 'loading' }

/**
 * The archive of `groupChatId` while `enabled`, and `loading` otherwise.
 *
 * Read again whenever `revision` changes: pass the value the host replaces
 * when it reloads the chat (its active list), so an archive or unarchive
 * anywhere on the screen reaches this list too. A reload keeps the list it
 * has on screen until the new one arrives.
 */
export function useArchivedThreads(groupChatId: string, enabled: boolean, revision: unknown): ArchivedThreads {
  const [read, setRead] = useState<{ groupChatId: string; archive: ArchivedThreads } | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies(revision): not read in the body -- the host replacing it is what asks for a fresh read
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    listGroupChatThreadsView({ data: { groupChatId, list: 'archive' } })
      .then((threads) => {
        if (!cancelled) {
          setRead({ groupChatId, archive: { state: 'loaded', threads } })
        }
      })
      .catch((err) => {
        console.error('Failed to load archived threads', groupChatId, err)
        if (!cancelled) {
          setRead({ groupChatId, archive: { state: 'failed' } })
        }
      })
    return () => {
      cancelled = true
    }
  }, [groupChatId, enabled, revision])
  return enabled && read?.groupChatId === groupChatId ? read.archive : LOADING
}
