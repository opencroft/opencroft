import { Flex } from 'ui/components/ui/layout/flex'
import { ScrollContent, ScrollFooter, ScrollHeader, ScrollPage } from 'ui/components/ui/layout/scrollpage'
import { BackButton, useTitlebar } from 'ui/components/ui/layout/titlebar'
import { cn } from 'cn'

export interface MenuLayoutProps {
  isOpened: boolean
  onClosed?: () => void
  menuHeader?: React.ReactNode
  menu: React.ReactNode
  menuFooter?: React.ReactNode
  children: React.ReactNode
}

export function MenuLayout({ isOpened, onClosed, menuHeader, menu, menuFooter, children }: MenuLayoutProps) {
  useTitlebar(isOpened && onClosed ? <BackButton className='flex md:hidden' onClick={onClosed} /> : null, [
    isOpened,
    onClosed,
  ])

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

      {/* Children content - show when !isOpened on small screens, always show on md+ screens */}
      <Flex expanded className={cn(!isOpened && 'hidden md:flex')}>
        {children}
      </Flex>
    </Flex>
  )
}
