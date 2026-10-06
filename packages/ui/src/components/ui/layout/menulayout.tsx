import * as React from 'react'
import { cn } from 'cn'
import { BackButton } from '../utils/back-button'
import { Flex } from './flex'
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
  children: React.ReactNode
}

export function MenuLayout({ isOpened, onClosed, menuHeader, menu, menuFooter, children }: MenuLayoutProps) {
  return (
    <Flex row expanded className='min-h-0'>
      {/* Menu sidebar - show when isOpened on small screens, always show on md+ screens */}
      <Flex className={cn('h-full w-full md:w-96 border-r-0 md:border-r', isOpened && 'hidden md:flex')}>
        <ScrollPage>
          {menuHeader && <ScrollHeader>{menuHeader}</ScrollHeader>}
          <ScrollContent className='p-0'>{menu}</ScrollContent>
          {menuFooter && <ScrollFooter>{menuFooter}</ScrollFooter>}
        </ScrollPage>
      </Flex>

      {/* Children content - show when !isOpened on small screens, always show on md+ screens.
          The panel never grows past the width it is given: content wider than that wraps or
          scrolls inside the panel, never widens the page. */}
      <Flex expanded className={cn('min-w-0', !isOpened && 'hidden md:flex')}>
        {onClosed && (
          <div className='flex shrink-0 items-center border-b px-2 py-1 md:hidden'>
            <BackButton onClick={onClosed} className='pointer-coarse:size-10' />
          </div>
        )}
        {children}
      </Flex>
    </Flex>
  )
}
