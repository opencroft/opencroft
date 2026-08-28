'use client'

import { createContext, type DependencyList, type ReactNode, useContext, useEffect, useState } from 'react'

interface GroupChatsSlotValue {
  content: ReactNode
  setContent: (content: ReactNode) => void
}

const GroupChatsSlotContext = createContext<GroupChatsSlotValue | null>(null)

/**
 * The sidebar's "Group chats" section, and what the open page puts in it.
 *
 * A group chat's screen already loads its threads and how they are arranged.
 * The sidebar shows the same list, and having it fetch that itself would be two
 * paths to one list -- which stay in step for exactly as long as nobody changes
 * either. So the page hands over what it already has, and this is the seam it
 * hands it over through.
 *
 * What crosses is a rendered node, not the data. That keeps the direction of
 * knowledge right: the shell does not learn what a thread is, and the page does
 * not reach into the sidebar's markup. Same shape as the titlebar's slot, on
 * purpose -- a reader who knows that one knows this one.
 */
export function GroupChatsSlotProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode>(null)
  return <GroupChatsSlotContext.Provider value={{ content, setContent }}>{children}</GroupChatsSlotContext.Provider>
}

/** What the open page has published, or null. Read by the sidebar. */
export function useGroupChatsSlotContent(): ReactNode {
  return useContext(GroupChatsSlotContext)?.content ?? null
}

/**
 * Publish `content` for as long as the caller is mounted; clear it on the way
 * out, so navigating away from a chat empties the section rather than leaving
 * the last one's threads behind.
 *
 * `deps` is the caller's, exactly as the titlebar's is. `content` is a fresh
 * element on every render, so an effect keyed on it would set state on every
 * render and never settle; the caller passes the values the node is built from
 * instead.
 *
 * Degrades to a no-op with no provider above it, so a page that publishes here
 * can still be rendered on its own.
 */
export function useGroupChatsSlot(content: ReactNode, deps: DependencyList) {
  const context = useContext(GroupChatsSlotContext)

  useEffect(() => {
    if (!context) {
      return
    }
    context.setContent(content)
    return () => {
      context.setContent(null)
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller supplies the dependencies, per the doc comment above
  }, deps)
}
