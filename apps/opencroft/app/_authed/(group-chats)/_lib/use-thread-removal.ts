'use client'

// Whether the thread on screen is still there, asked again each time the
// server reports a change to its chat. A thread deleted elsewhere -- in
// another tab, by another member, by an agent -- announces a change to its
// chat like every other write to it, so this is the moment to ask; nothing is
// polled.
//
// Only an answer moves the reader. A lookup that fails says nothing about the
// thread, and the screen stays as it is until the next change asks again.

import { useEffect, useRef } from 'react'

import { useGroupChatChanges } from '@/app/_authed/(group-chats)/_lib/group-chat-changes'
import type { GroupChatThreadInChat } from '@/app/_authed/(group-chats)/_server/actions'

/** Why an open thread can no longer be shown: deleted, or the reader left its chat. */
export type ThreadRemoval = Exclude<GroupChatThreadInChat['state'], 'ok'>

/** Looks a thread up inside its chat; `findGroupChatThreadInChat` in the app. */
export type ThreadLookup = (ids: { groupChatId: string; threadId: string }) => Promise<GroupChatThreadInChat>

/**
 * Calls `onRemoved` once when a change to `groupChatId` turns out to have
 * removed `threadId` from the reader's reach. An answer that arrives after the
 * thread was left, or for a thread other than the one now open, is dropped.
 * `onRemoved` is read through a ref, so an inline callback re-arms nothing.
 */
export function useThreadRemoval(
  groupChatId: string,
  threadId: string,
  lookup: ThreadLookup,
  onRemoved: (removal: ThreadRemoval) => void,
): void {
  const latest = useRef({ threadId, lookup, onRemoved })
  latest.current = { threadId, lookup, onRemoved }
  // The thread whose removal was reported, so overlapping lookups for one
  // burst of changes move the reader once.
  const reported = useRef<string | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useGroupChatChanges(groupChatId, true, () => {
    const asked = latest.current.threadId
    latest.current
      .lookup({ groupChatId, threadId: asked })
      .then((result) => {
        if (result.state === 'ok' || !mounted.current) {
          return
        }
        if (latest.current.threadId !== asked || reported.current === asked) {
          return
        }
        reported.current = asked
        latest.current.onRemoved(result.state)
      })
      .catch(() => {
        // Not an answer about the thread; the next change asks again.
      })
  })
}
