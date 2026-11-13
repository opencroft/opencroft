// Which history entries sit under a thread, so Back -- the screens' own and the
// browser's or phone's -- steps up through the levels a thread is reached by:
// its chat's thread list, then (below md, where each level is a screen of its
// own) the chats list. Pure, so the decision is testable without a router; the
// hooks that act on it are in use-thread-levels.ts.

declare module '@tanstack/history' {
  interface HistoryState {
    /**
     * On a thread's entry: the entries under it are the way the thread is
     * reached in the app -- its chat's thread list, or a thread of the same
     * chat it was opened from. Absent, the thread arrived some other way (a
     * fresh load of its address, a link elsewhere in the app) and is given
     * those entries on arrival.
     */
    threadReachedInChat?: true
  }
}

/** The state a navigation into a thread from inside its own chat carries. */
export const REACHED_IN_CHAT = { threadReachedInChat: true } as const

/** The chats page's own address: the chats list, alone below md. */
export const CHATS_PATH = '/group-chats'

/** A level a thread sits under: the chats list, or its chat's thread list. */
export type ThreadLevel = 'chats' | 'chat'

function trimSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * The levels to add under a thread whose entry would otherwise sit straight on
 * `below` (the path of the entry under it; undefined when nothing in-app is
 * known there). Side by side the chats list is always on screen, so only the
 * chat's level is a step of its own; below md the chats list is one too. A
 * level `below` already is is not added again.
 */
export function levelsUnderThread({
  below,
  chatPath,
  bothPanels,
}: {
  below: string | undefined
  chatPath: string
  bothPanels: boolean
}): ThreadLevel[] {
  const under = below === undefined ? undefined : trimSlash(below)
  if (under === trimSlash(chatPath)) {
    return []
  }
  if (bothPanels || under === CHATS_PATH) {
    return ['chat']
  }
  return ['chats', 'chat']
}
