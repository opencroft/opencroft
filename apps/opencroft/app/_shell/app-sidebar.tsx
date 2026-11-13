'use client'

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useSidebar } from 'ui/sidebar'

/**
 * The left sidebar belongs to whichever page has something to put in it.
 *
 * A page renders its panels through AppSidebar where it already is; they are
 * portalled into the shell's sidebar, so they keep the page's own state and
 * leave with the page. The shell draws the sidebar, and the title bar its
 * sidebar button, only while at least one AppSidebar is mounted, so a page
 * that offers nothing shows no sidebar and no button for one.
 *
 * The page also says how the sidebar sits beside it: `push` moves the content
 * aside, `overlay` floats above the page's viewport without moving it, while
 * the page's UI area still makes room for it (see AppViewport) — for content
 * with no edge to push, such as an endless canvas.
 */
export type AppSidebarMode = 'push' | 'overlay'

interface AppSidebarSlot {
  node: HTMLElement | null
  setNode: (node: HTMLElement | null) => void
  users: number
  setUsers: Dispatch<SetStateAction<number>>
  mode: AppSidebarMode
  setMode: Dispatch<SetStateAction<AppSidebarMode>>
  /** Closes the sidebar's sheet on a phone; set by the shell while it draws one. */
  closeSheet: RefObject<(() => void) | null>
}

const AppSidebarContext = createContext<AppSidebarSlot | null>(null)

export function AppSidebarProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [users, setUsers] = useState(0)
  const [mode, setMode] = useState<AppSidebarMode>('push')
  const closeSheet = useRef<(() => void) | null>(null)
  const value = useMemo(() => ({ node, setNode, users, setUsers, mode, setMode, closeSheet }), [node, users, mode])
  return <AppSidebarContext.Provider value={value}>{children}</AppSidebarContext.Provider>
}

/** For the shell: whether any page has sidebar content, where to mount it, and how it sits. */
export function useAppSidebarSlot() {
  const slot = useContext(AppSidebarContext)
  return { hasContent: (slot?.users ?? 0) > 0, setNode: slot?.setNode, mode: slot?.mode ?? 'push' }
}

/**
 * For the shell, inside the sidebar's provider: hands the page the way to
 * close the sidebar's sheet (useCloseSidebarSheet).
 */
export function ProvideSheetClose() {
  const slot = useContext(AppSidebarContext)
  const { setOpenMobile } = useSidebar()
  useLayoutEffect(() => {
    if (!slot) {
      return
    }
    slot.closeSheet.current = () => setOpenMobile(false)
    return () => {
      slot.closeSheet.current = null
    }
  }, [slot, setOpenMobile])
  return null
}

/**
 * Closes the sidebar's sheet, for a page opening a full-screen cover of its
 * own on a phone: the sheet is a modal above every page and would otherwise
 * stay on top of the cover. Does nothing where the shell draws no sidebar.
 */
export function useCloseSidebarSheet() {
  const slot = useContext(AppSidebarContext)
  return useCallback(() => slot?.closeSheet.current?.(), [slot])
}

export function AppSidebar({ mode = 'push', children }: { mode?: AppSidebarMode; children: ReactNode }) {
  const slot = useContext(AppSidebarContext)
  const setUsers = slot?.setUsers
  const setMode = slot?.setMode

  useLayoutEffect(() => {
    if (!setUsers) {
      return
    }
    setUsers((count) => count + 1)
    return () => setUsers((count) => count - 1)
  }, [setUsers])

  // Back to the default once this page's sidebar leaves, so the next page
  // does not inherit a mode it never asked for.
  useLayoutEffect(() => {
    setMode?.(mode)
    return () => setMode?.('push')
  }, [setMode, mode])

  return slot?.node ? createPortal(children, slot.node) : null
}
