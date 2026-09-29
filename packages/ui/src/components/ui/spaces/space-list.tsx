import { LayoutGrid, Pin, Plus, Settings } from 'lucide-react'
import type { MouseEvent } from 'react'

import { Button, buttonVariants } from '../button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from 'ui/components/ui/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../table'
import { cn } from 'cn'

import { SpaceIcon } from './space-icon'

export interface SpaceListSpace {
  slug: string
  name: string
  /** The stored icon, drawn by Space Icon: `preset:<glyph>:<colour>` or an image URL. */
  icon: string
  pinned?: boolean
  // Display-ready strings. The host formats them; this renders verbatim.
  updatedAt: string
  createdAt: string
}

export interface SpaceListProps {
  spaces: SpaceListSpace[]
  hrefFor: (slug: string) => string
  settingsHrefFor: (slug: string) => string
  /**
   * A plain press on any link here, so a client router can take the navigation
   * over. Without it the browser follows the link. A modified press (new tab,
   * new window) always stays with the browser.
   */
  onNavigate?: (href: string) => void
  /** The reader asked for a new space. Naming it is the host's. */
  onCreate: () => void
  onTogglePin: (slug: string, pinned: boolean) => void
  className?: string
}

function opensElsewhere(event: MouseEvent) {
  return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
}

export function SpaceList({
  spaces,
  hrefFor,
  settingsHrefFor,
  onNavigate,
  onCreate,
  onTogglePin,
  className,
}: SpaceListProps) {
  function linkClick(href: string) {
    return (event: MouseEvent<HTMLAnchorElement>) => {
      if (!onNavigate || opensElsewhere(event)) {
        return
      }
      event.preventDefault()
      onNavigate(href)
    }
  }

  if (spaces.length === 0) {
    return (
      <Empty className={cn('flex-1', className)}>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <LayoutGrid />
          </EmptyMedia>
          <EmptyTitle>No spaces yet</EmptyTitle>
          <EmptyDescription>A space holds your graphs, apps and chats. Create one to get started.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type='button' onClick={onCreate}>
            <Plus /> New space
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className='flex items-center justify-between gap-4'>
        <p className='text-sm text-muted-foreground'>
          {spaces.length} {spaces.length === 1 ? 'space' : 'spaces'}
        </p>
        <Button type='button' onClick={onCreate}>
          <Plus /> New space
        </Button>
      </div>

      <div className='rounded-lg border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-10 pr-0'>
                <span className='sr-only'>Pinned</span>
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead className='hidden sm:table-cell'>Slug</TableHead>
              <TableHead className='hidden md:table-cell'>Updated</TableHead>
              <TableHead className='hidden lg:table-cell'>Created</TableHead>
              <TableHead className='w-12'>
                <span className='sr-only'>Settings</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spaces.map((space) => {
              const href = hrefFor(space.slug)
              const settingsHref = settingsHrefFor(space.slug)
              return (
                <TableRow key={space.slug}>
                  <TableCell className='pr-0'>
                    <Button
                      type='button'
                      variant='ghost'
                      size='icon'
                      aria-pressed={Boolean(space.pinned)}
                      aria-label={space.pinned ? `Unpin ${space.name}` : `Pin ${space.name}`}
                      title={space.pinned ? 'Unpin' : 'Pin'}
                      className={space.pinned ? 'text-foreground' : 'text-muted-foreground'}
                      onClick={() => onTogglePin(space.slug, !space.pinned)}
                    >
                      <Pin className={cn(space.pinned && 'fill-current')} />
                    </Button>
                  </TableCell>
                  <TableCell>
                    <a
                      href={href}
                      onClick={linkClick(href)}
                      className='flex min-w-0 items-center gap-2 font-medium hover:underline'
                    >
                      <SpaceIcon icon={space.icon} className='size-6' />
                      <span className='truncate'>{space.name}</span>
                    </a>
                  </TableCell>
                  <TableCell className='hidden font-mono text-xs text-muted-foreground sm:table-cell'>
                    {space.slug}
                  </TableCell>
                  <TableCell className='hidden whitespace-nowrap text-muted-foreground md:table-cell'>
                    {space.updatedAt}
                  </TableCell>
                  <TableCell className='hidden whitespace-nowrap text-muted-foreground lg:table-cell'>
                    {space.createdAt}
                  </TableCell>
                  <TableCell className='text-right'>
                    <a
                      href={settingsHref}
                      onClick={linkClick(settingsHref)}
                      aria-label={`${space.name} settings`}
                      title='Space settings'
                      className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'text-muted-foreground')}
                    >
                      <Settings />
                    </a>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
