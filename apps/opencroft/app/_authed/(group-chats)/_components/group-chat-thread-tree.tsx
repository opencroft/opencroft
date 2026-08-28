'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChatList, type ChatListNode } from 'ui/chat/chat-list'

import {
  layoutToNodes,
  nodesToLayout,
  type ThreadStatusById,
} from '@/app/_authed/(group-chats)/_lib/thread-tree-layout'
import type {
  GroupChatThreadEntry,
  ThreadLayout,
  VersionedThreadLayout,
} from '@/app/_authed/(group-chats)/_server/actions'
import { saveGroupChatThreadLayout } from '@/app/_authed/(group-chats)/_server/actions'

interface GroupChatThreadTreeProps {
  groupChatId: string
  threads: GroupChatThreadEntry[]
  /** Live process state per thread, from the shared session-activity poll. */
  statusById: ThreadStatusById
  /** The saved arrangement as of the last load. */
  layout: VersionedThreadLayout
  activeId?: string
  onSelect: (threadId: string) => void
  onRename: (threadId: string) => void
  onStopProcess: (threadId: string) => void
  onDelete: (threadId: string) => void
  className?: string
}

// One group chat's threads as a foldered, reorderable list.
//
// The list itself is the kit's ChatList, unchanged and unwrapped -- the same
// component, the same gestures and the same timings the sidebar's chat list
// has always had. Everything here is the two things it does not do: turn
// threads into rows, and persist the arrangement.
export function GroupChatThreadTree({
  groupChatId,
  threads,
  statusById,
  layout,
  activeId,
  onSelect,
  onRename,
  onStopProcess,
  onDelete,
  className,
}: GroupChatThreadTreeProps) {
  // What is on screen, which runs ahead of the server between a drag and its
  // acknowledgement. Deliberately carries no version: a tree that has not been
  // acknowledged has no version, and pairing one with it would be inventing the
  // value the whole check turns on.
  const [shown, setShown] = useState<ThreadLayout>(layout.layout)
  // The version the server last CONFIRMED, and the one the next write claims.
  const confirmedVersion = useRef(layout.version)
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
    if (layout.version > confirmedVersion.current) {
      confirmedVersion.current = layout.version
      setShown(layout.layout)
    }
  }, [layout])

  const flush = async (first: ThreadLayout) => {
    saving.current = true
    let tree: ThreadLayout | null = first
    try {
      while (tree) {
        const result = await saveGroupChatThreadLayout({
          data: { groupChatId, layout: tree, expectedVersion: confirmedVersion.current },
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
          toast('Someone else changed this list, so it has been refreshed.')
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
    // The list has already redrawn itself; holding our copy back until the
    // server answers would make every drag flicker.
    setShown(tree)
    if (saving.current) {
      queued.current = tree
      return
    }
    void flush(tree)
  }

  return (
    <ChatList
      nodes={layoutToNodes(shown, threads, statusById)}
      activeId={activeId}
      onSelect={onSelect}
      onRename={onRename}
      onStopProcess={onStopProcess}
      onDelete={onDelete}
      onChange={persist}
      className={className}
    />
  )
}
