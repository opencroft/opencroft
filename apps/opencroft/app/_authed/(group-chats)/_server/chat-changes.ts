// That something in a group chat changed which an open settings dialog shows:
// who is in it, which automated senders it grants, and which threads are in
// its archive. Announced by the writes themselves, whoever made them -- this
// page, another tab, an agent, an App action -- and pushed to the people in
// the chat over the app's event stream, where the page reloads what it shows.
//
// The announcement carries no content, only which chat. What changed is read
// back through the membership-gated reads, so a reader learns nothing here
// that those reads would not tell them.

/** One change to a chat. `removedUserId` is the person a removal took out: not a member after it, but possibly with the chat open. */
export interface GroupChatChange {
  groupChatId: string
  removedUserId?: string
}

const listeners = new Set<(change: GroupChatChange) => void>()

/** Tell every subscriber that `change.groupChatId` changed. Called after the write has landed. */
export function announceGroupChatChange(change: GroupChatChange): void {
  for (const listener of listeners) {
    listener(change)
  }
}

/** Called once per announced change. Returns the unsubscribe. */
export function subscribeGroupChatChanges(listener: (change: GroupChatChange) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
