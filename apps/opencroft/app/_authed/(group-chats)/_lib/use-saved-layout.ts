'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ChatListNode } from 'ui/chat/chat-list'

import { nodesToLayout } from '@/app/_authed/(group-chats)/_lib/thread-tree-layout'
import type {
  SaveThreadLayoutResult,
  ThreadLayout,
  VersionedThreadLayout,
} from '@/app/_authed/(group-chats)/_server/actions'

/** Saves a whole arrangement at the version it is based on. */
export type SaveLayout = (layout: ThreadLayout, expectedVersion: number) => Promise<SaveThreadLayoutResult>

/**
 * The save bookkeeping for one saved list. A screen that stays mounted while
 * the reader moves to another list -- the chats page does, its route only
 * changes a parameter -- starts a new one, so nothing of the list it left (its
 * tree, its version, a save still in flight) is drawn or written in the next.
 */
interface LayoutSession {
  key: string
  save: SaveLayout
  // The version the server last CONFIRMED, and the one the next write claims.
  version: number
  saving: boolean
  // A tree that arrived while a save was in flight. Only the newest is kept:
  // each one is a complete list, so an older one has nothing the newer lacks.
  queued: ThreadLayout | null
}

/**
 * A list arrangement kept on the server at a version -- a chat's thread list,
 * or a person's Recent: what to draw, and how a change is saved.
 *
 * `key` names the list; another key is another list and starts afresh from
 * `loaded`. `save` is read when a list starts, so a caller may pass a new
 * function on every render.
 *
 * The state is here rather than inside the list because the same arrangement
 * can be drawn in two places at once -- a chat's own screen and the sidebar.
 * Two lists each holding their own copy would drift the moment one of them was
 * dragged, and the second one's next save would lose the version check and
 * report the person's own change as somebody else's.
 */
export function useSavedLayout(key: string, loaded: VersionedThreadLayout, save: SaveLayout) {
  // What is on screen, which runs ahead of the server between a drag and its
  // acknowledgement, and the session it was drawn for. The tree deliberately
  // carries no version: a tree that has not been acknowledged has no version,
  // and pairing one with it would be inventing the value the whole check turns
  // on.
  let [shown, setShown] = useState<{ session: LayoutSession; layout: ThreadLayout }>(() => ({
    session: { key, save, version: loaded.version, saving: false, queued: null },
    layout: loaded.layout,
  }))
  // Another list starts its own session from what was loaded for it. The
  // router renders a chat switch inside a transition, which React may
  // interrupt or abandon; as a state update, the new session exists only if
  // that render commits, and the list still on screen keeps its own.
  if (shown.session.key !== key) {
    shown = {
      session: { key, save, version: loaded.version, saving: false, queued: null },
      layout: loaded.layout,
    }
    setShown(shown)
  }
  const { session, layout } = shown

  // The session on screen, for a save that settles after the reader has moved
  // on and for the loader's effect. Set once a render commits, so an abandoned
  // render never becomes it.
  const sessionRef = useRef(session)
  useLayoutEffect(() => {
    sessionRef.current = session
  }, [session])

  // A newer layout from the server replaces what is on screen; anything else is
  // our own write coming back around the loader and is ignored. Comparing
  // versions rather than trusting the prop is what stops a route invalidation
  // -- deleting a thread causes one -- from undoing an arrangement made since
  // the page loaded.
  useEffect(() => {
    const current = sessionRef.current
    if (loaded.version > current.version) {
      current.version = loaded.version
      setShown({ session: current, layout: loaded.layout })
    }
  }, [loaded])

  const flush = async (owner: LayoutSession, first: ThreadLayout) => {
    owner.saving = true
    let tree: ThreadLayout | null = first
    try {
      while (tree) {
        const result = await owner.save(tree, owner.version)
        if (!result.ok) {
          // Someone else got there first. Take their arrangement and say so --
          // NOT silently. A drag that visibly undoes itself with no explanation
          // reads as a broken app, and the next thing anyone does is repeat the
          // drag, which is the same race again.
          //
          // Anything queued behind this is dropped: it was built on the tree
          // that just lost, so sending it would be the clobber this refusal
          // exists to prevent.
          owner.queued = null
          owner.version = result.current.version
          // A reader who has moved on to another list is not shown this one's
          // arrangement, nor told about it.
          if (sessionRef.current !== owner) {
            return
          }
          setShown({ session: owner, layout: result.current.layout })
          // "Someone else" would be a guess: the store records no author, so
          // this cannot tell another member apart from the same person in a
          // second tab, or from a write of our own whose response was lost.
          // What IS true in every case that reaches here is that the list
          // changed somewhere other than in front of this reader.
          toast('This list changed elsewhere and has been refreshed.')
          return
        }
        owner.version = result.version
        tree = owner.queued
        owner.queued = null
      }
    } catch (error) {
      // A fault, not a refusal: the arrangement stays on screen unsaved, and
      // the next drag retries it at the same version. The one thing this cannot
      // tell apart is a write that landed and whose response was lost -- that
      // one loses the race next time and reports it as someone else's change.
      owner.queued = null
      console.error('Failed to save the list layout', owner.key, error)
      toast('That arrangement could not be saved.')
    } finally {
      owner.saving = false
    }
  }

  const persist = (nodes: ChatListNode[]) => {
    const tree = nodesToLayout(nodes)
    // The list has already redrawn itself; holding this back until the server
    // answers would make every drag flicker.
    setShown({ session, layout: tree })
    if (session.saving) {
      session.queued = tree
      return
    }
    void flush(session, tree)
  }

  return { layout, persist }
}
