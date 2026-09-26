'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Artifact } from 'ui/group-chat/thread-artifacts'

import { listThreadArtifacts } from '@/app/_authed/(group-chats)/_server/actions'
import type { ThreadArtifact } from '@/app/_authed/(group-chats)/_server/artifacts'

/** The open thread's notes, for a host that draws the thread's header: the
 *  notes in list order for its menu, and which one is open for the split that
 *  shows it. Identity-stable per change of its parts, like the rest of the
 *  thread context it travels in. */
export interface ThreadArtifacts {
  items: Artifact[]
  /** The note on screen, if any. */
  open: Artifact | null
  openId?: string
  onOpen: (id: string) => void
  close: () => void
}

/**
 * The embedded thread's artifacts: the same list the full thread view shows,
 * loaded when a thread resolves, refreshed when a turn settles, and which one
 * is open. Nothing here survives a change of thread -- a note belongs to the
 * thread it was written on, so another thread starts with its own list and
 * nothing open.
 */
export function useThreadArtifacts(threadId: string | undefined) {
  const [items, setItems] = useState<ThreadArtifact[]>([])
  const [openId, setOpenId] = useState<string | undefined>(undefined)

  // A load or refresh that resolves after the reader has moved to another
  // thread must not put the previous thread's notes on this one -- the same
  // guard the thread route keeps on its own refresh.
  const threadIdRef = useRef(threadId)
  threadIdRef.current = threadId

  const load = useCallback((id: string) => {
    listThreadArtifacts({ data: id })
      .then((next) => {
        if (threadIdRef.current === id) {
          setItems(next)
        }
      })
      .catch((error) => {
        // A failed load leaves the last known list on screen, which is better
        // than emptying a menu the reader was using.
        console.error('Failed to load thread artifacts', id, error)
      })
  }, [])

  useEffect(() => {
    setItems([])
    setOpenId(undefined)
    if (threadId) {
      load(threadId)
    }
  }, [threadId, load])

  // An agent writes its notes DURING a turn, and there is no push for them, so
  // a settled turn is the signal to look again.
  const refresh = useCallback(() => {
    if (threadId) {
      load(threadId)
    }
  }, [threadId, load])

  const close = useCallback(() => setOpenId(undefined), [])
  // A note deleted while open simply stops being found: the conversation comes
  // back, and the menu marks nothing.
  const open = items.find((artifact) => artifact.id === openId) ?? null
  const artifacts = useMemo<ThreadArtifacts>(
    () => ({ items, open, openId: open?.id, onOpen: setOpenId, close }),
    [items, open, close],
  )

  return { artifacts, refresh }
}
