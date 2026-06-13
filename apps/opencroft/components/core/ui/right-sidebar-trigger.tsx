'use client'

import { PanelRightIcon } from 'lucide-react'
import { Button } from 'ui/button'
import { useSidebar } from 'ui/sidebar'

import { cn } from '@/lib/utils'

type RightSidebarTriggerProps = React.ComponentProps<typeof Button>

export function RightSidebarTrigger({ className, onClick, ...props }: RightSidebarTriggerProps) {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      data-sidebar='trigger'
      data-slot='sidebar-trigger'
      variant='ghost'
      size='icon'
      className={cn('size-7', className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelRightIcon />
      <span className='sr-only'>Toggle right sidebar</span>
    </Button>
  )
}
