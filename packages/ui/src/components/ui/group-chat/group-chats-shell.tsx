'use client'

import type { ReactNode } from 'react'

import { MenuLayout, type MenuLayoutProps } from 'ui/components/ui/layout/menulayout'

export interface GroupChatsShellProps {
  /** The group chats -- a Group Chat List -- at the top of the left panel. */
  chats: ReactNode
  /** Under the chats: the threads opened most recently (Recent Threads). */
  recent?: ReactNode
  /** Whether a chat or a thread is open. Below md it decides which panel
   * fills the screen: the left one while nothing is open, the open one after.
   * From md up both panels show either way. */
  isOpened: boolean
  /** Where the left panel's width starts and where a width the person drags
   * it to goes. From md up the boundary is draggable either way; omitted, the
   * panel starts at its default width and a chosen width lasts while the shell
   * stays mounted. */
  menuResize?: MenuLayoutProps['menuResize']
  /** The right panel: the open chat, the open thread, or -- from md up, with
   * nothing open -- what to show until something is. Each screen it holds
   * draws its own header and its own Back, which is the way up a level below
   * md: this shell draws none, so a phone never shows two. */
  children: ReactNode
}

// The chats page: one page with the chats on the left and the open chat or
// thread on the right, rather than a page per level. From md up the left panel
// never goes away, so moving between chats, or from a thread to another
// chat's thread through Recent, never loses the map of where everything is.
//
// Below md there is no room for two panels, so each level is a screen of its
// own -- the left panel, then a chat's threads, then a thread -- and the host
// keeps one history entry per level, so the screens' Back and the system's
// Back both go up one. The shell only decides which panel shows; which chat
// or thread is open is the host's, usually its URL.
//
// From md up the boundary between the panels is draggable: chat and thread
// names truncate, and a person with long ones widens the left panel rather
// than reading them cut.
export function GroupChatsShell({ chats, recent, isOpened, menuResize = {}, children }: GroupChatsShellProps) {
  return (
    <MenuLayout
      isOpened={isOpened}
      menuResize={menuResize}
      menu={
        <div className='flex w-full min-w-0 flex-col gap-2 p-2'>
          {chats}
          {recent}
        </div>
      }
    >
      {children}
    </MenuLayout>
  )
}
