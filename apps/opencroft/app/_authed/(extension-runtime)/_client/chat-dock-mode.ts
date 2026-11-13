'use client'

import { createContext, useContext } from 'react'
import type { DockSide } from 'ui/layouts/dock-panel'

import { useLocalStorage } from '@/hooks/utils/use-local-storage'

/** Where the chat panel sits when it is open: docked to an edge, or floating. */
export type ChatDockMode = DockSide | 'float'

const CHAT_DOCK_MODE_DEFAULT: ChatDockMode = 'right'

/**
 * The starting position of every App type that has none of its own, and the
 * position of a dock outside any App type, which is the only one that writes
 * it.
 */
const SHARED_MODE_KEY = 'opencroft.chatDock.mode'

/** Where the position chosen on one App type's surfaces is stored. */
function chatDockModeKey(appType: string): string {
  return `${SHARED_MODE_KEY}.${appType}`
}

/**
 * The App type of the surface a chat dock sits in, e.g. the task manager's or
 * the graph's. Provided by the host where it mounts a surface, so an App that
 * embeds the chat gets its own remembered position without saying anything;
 * null where no App type encloses the dock.
 */
export const ChatDockAppType = createContext<string | null>(null)

/**
 * The panel's position for the enclosing App type, and its setter, which
 * changes it for that type only. Per App type rather than per instance or
 * space: the graph can keep its chat floating over the canvas while the task
 * manager keeps it docked, and a second task manager opens like the first.
 *
 * Stored in this browser's local storage, read after mount: the server and
 * the first client render both draw the default, so they agree.
 */
export function useChatDockMode(): [ChatDockMode, (mode: ChatDockMode) => void] {
  const appType = useContext(ChatDockAppType)
  const [shared] = useLocalStorage<ChatDockMode>(SHARED_MODE_KEY, CHAT_DOCK_MODE_DEFAULT)
  const [own, setOwn] = useLocalStorage<ChatDockMode | undefined>(
    appType === null ? SHARED_MODE_KEY : chatDockModeKey(appType),
    undefined,
  )
  return [own ?? shared, setOwn]
}
