'use client'

import { EllipsisVertical, PanelLeft } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'ui/dropdown-menu'
import { TitleBarIconButton } from 'ui/layouts/title-bar'

import { PageLinks } from '@/app/_shell/account-menu'

/**
 * The phone's menu for the page itself, at the title bar's end: the page's
 * sidebar, when it has one, and the links of the account menu (copy this
 * page's link, open one from the clipboard). Back is the title bar's own, at
 * its start.
 */
export function PageMenu({ className, onSidebar }: { className?: string; onSidebar?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<TitleBarIconButton aria-label='Page' title='Page' className={className} />}>
        <EllipsisVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-56'>
        {onSidebar && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onSidebar}>
                <PanelLeft />
                Sidebar
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <PageLinks shown='always' separator={false} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
