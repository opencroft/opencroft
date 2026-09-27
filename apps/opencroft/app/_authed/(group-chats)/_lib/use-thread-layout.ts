'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ChatListNode } from 'ui/chat/chat-list'

import { nodesToLayout } from '@/app/_authed/(group-chats)/_lib/thread-tree-layout'
import type { ThreadLayout, ThreadList, VersionedThreadLayout } from '@/app/_authed/(group-chats)/_server/actions'
import { saveGroupChatThreadLayout } from '@/app/_authed/(group-chats)/_server/actions'

/**
 * One group chat's thread arrangement: what to draw, and how a change is saved.
 *
 * The state is here rather than inside the list because the same arrangement is
 * drawn in two places at once -- the chat's own screen and the sidebar. Two
 * lists each holding their own copy would drift the moment one of them was
 * dragged, and the second one's next save would lose the version check and
 * report the person's own change as somebody else's.
 */
export function useThreadLayout(groupChatId: string, list: ThreadList, loaded: VersionedThreadLayout) {
  // What is on screen, which runs ahead of the server between a drag and its
  // acknowledgement. Deliberately carries no version: a tree that has not been
  // acknowledged has no version, and pairing one with it would be inventing the
  // value the whole check turns on.
  const [shown, setShown] = useState<ThreadLayout>(loaded.layout)
  // The version the server last CONFIRMED, and the one the next write claims.
  const confirmedVersion = useRef(loaded.version)
  const saving = useRef(false)
  // A tree that arrived while a save was in flight. Only the newest is kept:
  // each one is a complete list, so an older one has nothing the newer lacks.
  const queued = useRef<ThreadLayout | null>(null)

  // A newer layout from the server replaces what is on screen; anything else is
  // our own write coming back around the loader and is ignored. Comparing
  // versions rather than trusting the prop is what stops a route invalidation
  // -- deleting a thread causes one -- from undoing an arrangement made since
  // the page loaded.
  useEffect(() => {
    if (loaded.version > confirmedVersion.current) {
      confirmedVersion.current = loaded.version
      setShown(loaded.layout)
    }
  }, [loaded])

  const flush = async (first: ThreadLayout) => {
    saving.current = true
    let tree: ThreadLayout | null = first
    try {
      while (tree) {
        const result = await saveGroupChatThreadLayout({
          data: { groupChatId, list, layout: tree, expectedVersion: confirmedVersion.current },
        })
        if (!result.ok) {
          // Someone else got there first. Take their arrangement and say so --
          // NOT silently. A drag that visibly undoes itself with no explanation
          // reads as a broken app, and the next thing anyone does is repeat the
          // drag, which is the same race again.
          //
          // Anything queued behind this is dropped: it was built on the tree
          // that just lost, so sending it would be the clobber this refusal
          // exists to prevent.
          queued.current = null
          confirmedVersion.current = result.current.version
          setShown(result.current.layout)
          // "Someone else" would be a guess: the store records no author, so
          // this cannot tell another member apart from the same person in a
          // second tab, or from a write of our own whose response was lost.
          // What IS true in every case that reaches here is that the list
          // changed somewhere other than in front of this reader.
          toast('This list changed elsewhere and has been refreshed.')
          return
        }
        confirmedVersion.current = result.version
        tree = queued.current
        queued.current = null
      }
    } catch (error) {
      // A fault, not a refusal: the arrangement stays on screen unsaved, and
      // the next drag retries it at the same version. The one thing this cannot
      // tell apart is a write that landed and whose response was lost -- that
      // one loses the race next time and reports it as someone else's change.
      queued.current = null
      console.error('Failed to save the thread layout', groupChatId, error)
      toast('That arrangement could not be saved.')
    } finally {
      saving.current = false
    }
  }

  const persist = (nodes: ChatListNode[]) => {
    const tree = nodesToLayout(nodes)
    // The list has already redrawn itself; holding this back until the server
    // answers would make every drag flicker.
    setShown(tree)
    if (saving.current) {
      queued.current = tree
      return
    }
    void flush(tree)
  }

  return { layout: shown, persist }
}
