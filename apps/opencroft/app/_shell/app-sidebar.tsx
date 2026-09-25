'use client'

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

/**
 * The left sidebar belongs to whichever page has something to put in it.
 *
 * A page renders its panels through AppSidebar where it already is; they are
 * portalled into the shell's sidebar, so they keep the page's own state and
 * leave with the page. The shell draws the sidebar, and the title bar its
 * sidebar button, only while at least one AppSidebar is mounted, so a page
 * that offers nothing shows no sidebar and no button for one.
 */
interface AppSidebarSlot {
  node: HTMLElement | null
  setNode: (node: HTMLElement | null) => void
  users: number
  setUsers: Dispatch<SetStateAction<number>>
}

const AppSidebarContext = createContext<AppSidebarSlot | null>(null)

export function AppSidebarProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [users, setUsers] = useState(0)
  const value = useMemo(() => ({ node, setNode, users, setUsers }), [node, users])
  return <AppSidebarContext.Provider value={value}>{children}</AppSidebarContext.Provider>
}

/** For the shell: whether any page has sidebar content, and where to mount it. */
export function useAppSidebarSlot() {
  const slot = useContext(AppSidebarContext)
  return { hasContent: (slot?.users ?? 0) > 0, setNode: slot?.setNode }
}

export function AppSidebar({ children }: { children: ReactNode }) {
  const slot = useContext(AppSidebarContext)
  const setUsers = slot?.setUsers

  useLayoutEffect(() => {
    if (!setUsers) {
      return
    }
    setUsers((count) => count + 1)
    return () => setUsers((count) => count - 1)
  }, [setUsers])

  return slot?.node ? createPortal(children, slot.node) : null
}
