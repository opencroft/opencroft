import { LayoutGrid, Plus, Settings } from 'lucide-react'
import { type MouseEvent, useState } from 'react'

import { Button, buttonVariants } from 'ui/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'ui/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/components/ui/popover'
import { cn } from 'ui/lib/utils'

import { TitleBarIconButton } from './title-bar'

export interface SelectorSpace {
  slug: string
  name: string
  /** A small square image URL; without one the space draws a grid glyph. */
  icon?: string | null
  pinned?: boolean
}

export interface SpaceSelectorProps {
  spaces: SelectorSpace[]
  currentSlug?: string
  hrefFor: (slug: string) => string
  /** Each space's settings page, drawn as an icon at the end of its row. */
  settingsHrefFor?: (slug: string) => string
  /** The page listing every space, reached from under the list. */
  allSpacesHref: string
  /** Where a new space is created; drawn as a plus beside the search. */
  createHref?: string
  /**
   * A plain press or Enter on any link here, so a client router can take the
   * navigation over. Without it the browser follows the link. A modified press
   * (new tab, new window) always stays with the browser.
   */
  onNavigate?: (href: string) => void
}

export function SpaceSelectorIcon({ icon, className }: { icon?: string | null; className?: string }) {
  if (icon) {
    return <img src={icon} alt='' className={cn('shrink-0 rounded-md object-cover', className)} />
  }
  return (
    <span className={cn('flex shrink-0 items-center justify-center', className)}>
      <LayoutGrid className='size-[80%]' />
    </span>
  )
}

function opensElsewhere(event: MouseEvent) {
  return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
}

export function SpaceSelector({
  spaces,
  currentSlug,
  hrefFor,
  settingsHrefFor,
  allSpacesHref,
  createHref,
  onNavigate,
}: SpaceSelectorProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const current = spaces.find((space) => space.slug === currentSlug)

  // An empty query shows the pinned spaces; typing searches all of them.
  const pinned = spaces.filter((space) => space.pinned)
  const shown = query || pinned.length === 0 ? spaces : pinned

  function close() {
    setOpen(false)
    setQuery('')
  }

  function go(href: string) {
    close()
    if (onNavigate) {
      onNavigate(href)
    } else {
      window.location.assign(href)
    }
  }

  // Every link here is real, so middle click and ctrl/cmd-click open a tab. It
  // stops the click from reaching the cmdk item, otherwise a ctrl-click would
  // open the tab AND move this one. A modified click leaves this tab where it
  // is, so the list stays open for the next one.
  function linkClick(href: string) {
    return (event: MouseEvent<HTMLAnchorElement>) => {
      event.stopPropagation()
      if (opensElsewhere(event)) {
        return
      }
      if (onNavigate) {
        event.preventDefault()
        go(href)
      } else {
        close()
      }
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger render={<TitleBarIconButton aria-label={current?.name ?? 'Spaces'} title={current?.name} />}>
        <SpaceSelectorIcon icon={current?.icon} className='size-5' />
      </PopoverTrigger>
      <PopoverContent className='w-64 gap-0 p-0' side='bottom' align='start'>
        <Command className='p-0'>
          <div className='flex items-center gap-1 pr-1 *:data-[slot=command-input-wrapper]:flex-1'>
            <CommandInput value={query} onValueChange={setQuery} placeholder='Search spaces…' />
            {createHref && (
              <a
                href={createHref}
                aria-label='New space'
                title='New space'
                className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'mt-1 size-8 shrink-0')}
                onClick={linkClick(createHref)}
              >
                <Plus />
              </a>
            )}
          </div>
          <CommandList>
            <CommandEmpty>No spaces found.</CommandEmpty>
            <CommandGroup>
              {shown.map((space) => {
                const href = hrefFor(space.slug)
                const settingsHref = settingsHrefFor?.(space.slug)
                return (
                  // Enter never reaches the links, so the item's onSelect
                  // carries the keyboard case. The stock item draws its own
                  // check for data-checked, which marks the current space.
                  <CommandItem
                    key={space.slug}
                    value={`${space.name} ${space.slug}`}
                    data-checked={space.slug === currentSlug}
                    className='p-0 pr-2'
                    onSelect={() => go(href)}
                  >
                    <a
                      href={href}
                      className='flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5'
                      onClick={linkClick(href)}
                    >
                      <SpaceSelectorIcon icon={space.icon} className='size-5' />
                      <span className='truncate'>{space.name}</span>
                    </a>
                    {settingsHref && (
                      <a
                        href={settingsHref}
                        aria-label={`${space.name} settings`}
                        title='Space settings'
                        className='flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-9'
                        onClick={linkClick(settingsHref)}
                      >
                        <Settings className='size-4' />
                      </a>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        <div className='border-t p-1'>
          <Button
            render={<a href={allSpacesHref} onClick={linkClick(allSpacesHref)} />}
            nativeButton={false}
            variant='ghost'
            size='sm'
            className='w-full justify-center'
          >
            More
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
