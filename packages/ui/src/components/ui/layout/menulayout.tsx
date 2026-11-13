import * as React from 'react'
import { cn } from 'cn'
import { BackButton } from '../utils/back-button'
import { Flex } from './flex'
import { type MenuResize, ResizableMenuColumns } from './resizable-menu-columns'
import { ScrollContent, ScrollFooter, ScrollHeader, ScrollPage } from './scrollpage'

export interface MenuLayoutProps {
  // Whether an item is open on a small screen, where the menu and the panel
  // take the whole width in turn.
  isOpened: boolean
  // Leaves the open item back to the menu. Given, a small screen draws Back
  // above the panel; omitted, the host draws its own way back.
  onClosed?: () => void
  menuHeader?: React.ReactNode
  menu: React.ReactNode
  menuFooter?: React.ReactNode
  // Given, the boundary between the menu and the panel is draggable from md
  // up, and the menu starts at and reports its width as MenuResize describes.
  // Below md the layout is the same as without it. Omitted, the menu is a
  // fixed 24rem column.
  menuResize?: MenuResize
  // The fixed menu column's width from md up: 'default' is 24rem; 'narrow' is
  // 13rem, for a menu of a few short entries beside a panel that needs the
  // room, such as a dialog's. Below md the menu takes the whole width either
  // way. A resizable menu sets its own width instead.
  menuWidth?: MenuWidth
  children: React.ReactNode
}

export type MenuWidth = 'default' | 'narrow'

const MENU_WIDTH_CLASS: Record<MenuWidth, string> = {
  default: 'md:w-96',
  narrow: 'md:w-52',
}

export function MenuLayout({
  isOpened,
  onClosed,
  menuHeader,
  menu,
  menuFooter,
  menuResize,
  menuWidth = 'default',
  children,
}: MenuLayoutProps) {
  const menuColumn = (
    <ScrollPage>
      {menuHeader && <ScrollHeader>{menuHeader}</ScrollHeader>}
      <ScrollContent className='p-0'>{menu}</ScrollContent>
      {menuFooter && <ScrollFooter>{menuFooter}</ScrollFooter>}
    </ScrollPage>
  )
  const panel = (
    <>
      {onClosed && (
        <div className='flex shrink-0 items-center border-b px-2 py-1 md:hidden'>
          <BackButton onClick={onClosed} className='pointer-coarse:size-10' />
        </div>
      )}
      {children}
    </>
  )

  if (menuResize) {
    return (
      <ResizableMenuColumns isOpened={isOpened} menu={menuColumn} {...menuResize}>
        {panel}
      </ResizableMenuColumns>
    )
  }

  return (
    <Flex row expanded className='min-h-0'>
      {/* Menu sidebar - show when isOpened on small screens, always show on md+ screens */}
      <Flex
        className={cn(
          'h-full w-full border-r-0 md:border-r',
          MENU_WIDTH_CLASS[menuWidth],
          isOpened && 'hidden md:flex',
        )}
      >
        {menuColumn}
      </Flex>

      {/* Children content - show when !isOpened on small screens, always show on md+ screens.
          The panel never grows past the width it is given: content wider than that wraps or
          scrolls inside the panel, never widens the page. */}
      <Flex expanded className={cn('min-w-0', !isOpened && 'hidden md:flex')}>
        {panel}
      </Flex>
    </Flex>
  )
}
