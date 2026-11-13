'use client'

// The group-chat changes the server pushes on the page's event stream: a chat
// the reader is in gained or lost a member or a grant, or a thread entered,
// left or was deleted from its archive. Each carries only the chat's id, and a
// reader that shows that chat reads it again.
//
// A change made while the stream was down is not replayed; what the reader
// holds stays as it was until the next change or the next read.

import { useEffect, useRef } from 'react'

const listeners = new Set<(groupChatId: string) => void>()

/** Take a `group_chat_changed` event from the page's event stream. */
export function receiveGroupChatChange(groupChatId: string): void {
  for (const listener of listeners) {
    listener(groupChatId)
  }
}

/** Calls `onChange` each time the server reports that `groupChatId` changed, while `enabled`. */
export function useGroupChatChanges(groupChatId: string, enabled: boolean, onChange: () => void): void {
  // The latest callback, so a caller passing a fresh closure each render
  // neither re-subscribes nor misses a change in between.
  const latest = useRef(onChange)
  latest.current = onChange
  useEffect(() => {
    if (!enabled) {
      return
    }
    const listener = (changed: string) => {
      if (changed === groupChatId) {
        latest.current()
      }
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [groupChatId, enabled])
}
