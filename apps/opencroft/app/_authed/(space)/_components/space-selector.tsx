'use client'

import { Link, useLocation, useRouter } from '@tanstack/react-router'
import { ChevronDown, Ellipsis, Pin, PinOff, Settings } from 'lucide-react'
import { type MouseEvent, useEffect, useState } from 'react'
import { Button } from 'ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'ui/command'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from 'ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/popover'
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from 'ui/sidebar'

import { SidebarApps } from '@/app/_authed/(apps)/_components/sidebar-apps'
import { SpaceIcon } from '@/app/_authed/(space)/_components/space-icon'
import { getActiveSpaceSlug, setSpacePinned } from '@/app/_authed/(space)/_server/actions'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

function slugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/space\/([^/]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

/**
 * The modifiers a browser reads as "open this link somewhere other than here".
 * The router's Link declines to handle exactly these, leaving the navigation to
 * the browser. A middle click is not among them because it raises `auxclick`
 * rather than `click`, so no click handler runs for it at all.
 */
function isOpenInNewTab(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
}

/**
 * The sidebar's space section: a selector for the current space (searchable
 * dropdown — pinned spaces when the query is empty, matches otherwise, with a
 * More footer leading to the full spaces page), a "…" menu (pin / settings),
 * and the current space's Apps.
 */
export function SpaceSidebarSection({ spaces }: { spaces: SpaceSummary[] }) {
  const pathname = useLocation({ select: (l) => l.pathname })
  const router = useRouter()
  const pathSlug = slugFromPath(pathname)
  // Off any /space/... route the selector still names a space — the active one.
  const [activeSlug, setActiveSlug] = useState<string | null>(null)
  useEffect(() => {
    if (!pathSlug) {
      getActiveSpaceSlug()
        .then(setActiveSlug)
        .catch(() => {})
    }
  }, [pathSlug])
  const slug = pathSlug ?? activeSlug
  const current = spaces.find((space) => space.slug === slug) ?? null

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Empty query shows the pinned spaces; typing searches ALL of them (the
  // Command list then filters what is rendered by the query).
  const pinned = spaces.filter((space) => space.pinned)
  const shown = query ? spaces : pinned.length > 0 ? pinned : spaces

  function close() {
    setOpen(false)
    setQuery('')
  }

  // Keyboard selection only: a pointer lands on the row's anchor instead.
  function select(space: SpaceSummary) {
    close()
    router.navigate({ to: '/space/$slug', params: { slug: space.slug } })
  }

  async function togglePin() {
    if (!current) {
      return
    }
    await setSpacePinned({ data: { slug: current.slug, pinned: !current.pinned } })
    router.invalidate()
  }

  return (
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem>
          <div className='flex items-center gap-1'>
            <Popover
              open={open}
              onOpenChange={(next) => {
                setOpen(next)
                if (!next) {
                  setQuery('')
                }
              }}
            >
              <PopoverTrigger render={<SidebarMenuButton tooltip='Spaces' />}>
                <SpaceIcon icon={current?.icon} className='size-5' />
                <span>{current?.name ?? 'Spaces'}</span>
                <ChevronDown className='ml-auto size-4 opacity-50' />
              </PopoverTrigger>
              <PopoverContent className='w-64 gap-0 p-0' side='bottom' align='start'>
                <Command className='p-0'>
                  <CommandInput value={query} onValueChange={setQuery} placeholder='Search spaces…' />
                  <CommandList>
                    <CommandEmpty>No spaces found.</CommandEmpty>
                    <CommandGroup>
                      {shown.map((space) => (
                        // The row is a real link so the browser's own
                        // open-in-a-new-tab gestures work on it: middle click,
                        // ctrl/cmd-click, and the context menu. cmdk selects on
                        // the item's click, which is why the anchor stops that
                        // event -- otherwise a ctrl-click would open the new tab
                        // AND move the current one. Keyboard Enter never reaches
                        // the anchor, so onSelect still carries that case.
                        <CommandItem
                          key={space.id}
                          value={`${space.name} ${space.slug}`}
                          // The stock item draws its own check at the row's end and
                          // shows it for data-checked -- so the row marks the current
                          // space through it rather than carrying a second icon.
                          data-checked={space.slug === slug}
                          className='p-0 pr-2'
                          onSelect={() => select(space)}
                        >
                          <Link
                            to='/space/$slug'
                            params={{ slug: space.slug }}
                            className='flex w-full items-center gap-2 px-2 py-1.5'
                            onClick={(event) => {
                              event.stopPropagation()
                              // A modified click leaves this tab where it is,
                              // so the list stays open for the next one.
                              if (!isOpenInNewTab(event)) {
                                close()
                              }
                            }}
                          >
                            <SpaceIcon icon={space.icon} className='size-5' />
                            {space.name}
                          </Link>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
                <div className='border-t p-1'>
                  <Button
                    render={<Link to='/spaces' />}
                    nativeButton={false}
                    variant='ghost'
                    size='sm'
                    className='w-full justify-center'
                    onClick={() => {
                      setOpen(false)
                      setQuery('')
                    }}
                  >
                    More
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant='ghost' size='icon' className='size-8 shrink-0' aria-label='Space menu' />}
              >
                <Ellipsis />
              </DropdownMenuTrigger>
              <DropdownMenuContent side='bottom' align='end' className='w-auto'>
                <DropdownMenuItem disabled={!current} onClick={togglePin}>
                  {current?.pinned ? <PinOff /> : <Pin />}
                  {current?.pinned ? 'Unpin space' : 'Pin space'}
                </DropdownMenuItem>
                {current ? (
                  <DropdownMenuItem render={<Link to='/space/$slug/settings' params={{ slug: current.slug }} />}>
                    <Settings />
                    Space settings
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem disabled>
                    <Settings />
                    Space settings
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {slug && <SidebarApps spaceSlug={slug} />}
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  )
}
