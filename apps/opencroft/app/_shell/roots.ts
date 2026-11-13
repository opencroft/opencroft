import { CircleUser, Layers, LayoutGrid, type LucideIcon, MessagesSquare } from 'lucide-react'

import { CHATS_PATH } from '@/app/_authed/(group-chats)/_lib/thread-levels'

export { CHATS_PATH }

/** Where the App Launcher is a page of its own: the phone's way to it. */
export const APPS_PATH = '/apps' as const

export const SPACES_PATH = '/spaces' as const

/** The phone's Account page: the account menu as a page. */
export const ACCOUNT_PATH = '/account' as const

export interface RootPage {
  path: string
  label: string
  icon: LucideIcon
}

/**
 * The root pages, in the bottom navigation's order, left to right: where it
 * shows, which way a switch between two of them slides, and how the chrome
 * names each one.
 */
export const ROOTS: RootPage[] = [
  { path: CHATS_PATH, label: 'Chats', icon: MessagesSquare },
  { path: APPS_PATH, label: 'Apps', icon: LayoutGrid },
  { path: SPACES_PATH, label: 'Spaces', icon: Layers },
  { path: ACCOUNT_PATH, label: 'Account', icon: CircleUser },
]

export const ROOT_PATHS: string[] = ROOTS.map((root) => root.path)

export function isRootPage(pathname: string) {
  return ROOT_PATHS.includes(pathname)
}
