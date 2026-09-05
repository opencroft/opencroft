'use client'

import { Link, useLocation, useRouter } from '@tanstack/react-router'
import { Check, ChevronDown, Ellipsis, List, Pin, PinOff, Settings } from 'lucide-react'
import { useEffect, useState } from 'react'
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
 * The sidebar's space section: a selector for the current space (searchable
 * dropdown — pinned spaces when the query is empty, matches otherwise), a
 * "…" menu (all spaces / pin / settings), and the current space's Apps.
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

  function select(space: SpaceSummary) {
    setOpen(false)
    setQuery('')
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
              <PopoverTrigger asChild>
                <SidebarMenuButton tooltip='Spaces'>
                  <SpaceIcon icon={current?.icon} className='size-5' />
                  <span>{current?.name ?? 'Spaces'}</span>
                  <ChevronDown className='ml-auto size-4 opacity-50' />
                </SidebarMenuButton>
              </PopoverTrigger>
              <PopoverContent className='w-64 p-0' side='bottom' align='start'>
                <Command>
                  <CommandInput value={query} onValueChange={setQuery} placeholder='Search spaces…' />
                  <CommandList>
                    <CommandEmpty>No spaces found.</CommandEmpty>
                    <CommandGroup>
                      {shown.map((space) => (
                        <CommandItem key={space.id} value={`${space.name} ${space.slug}`} onSelect={() => select(space)}>
                          <SpaceIcon icon={space.icon} className='size-5' />
                          {space.name}
                          <Check className={`ml-auto ${space.slug === slug ? 'opacity-100' : 'opacity-0'}`} />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant='ghost' size='icon' className='size-8 shrink-0' aria-label='Space menu'>
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side='bottom' align='end'>
                <DropdownMenuItem asChild>
                  <Link to='/spaces'>
                    <List />
                    All spaces
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!current} onClick={togglePin}>
                  {current?.pinned ? <PinOff /> : <Pin />}
                  {current?.pinned ? 'Unpin space' : 'Pin space'}
                </DropdownMenuItem>
                {current ? (
                  <DropdownMenuItem asChild>
                    <Link to='/space/$slug/settings' params={{ slug: current.slug }}>
                      <Settings />
                      Space settings
                    </Link>
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
