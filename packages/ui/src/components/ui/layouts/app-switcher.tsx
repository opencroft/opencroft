import { ChevronDown, LayoutGrid, Plus } from 'lucide-react'
import { type ComponentType, type MouseEvent, type ReactElement, type ReactNode, useState } from 'react'

import { Button, buttonVariants } from 'ui/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'ui/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/components/ui/popover'
import { cn } from 'cn'

export interface SwitcherApp {
  id: string
  label: string
  href: string
  icon?: ComponentType<{ className?: string }>
  /** What kind of app it is: designs, docs, graphs. One entry in the bar per type. */
  type: string
}

export interface AppSwitcherProps {
  apps: SwitcherApp[]
  activeId?: string
  /** Where a new app is added; drawn as a plus beside every search. */
  createHref?: string
  /**
   * A plain press or Enter on any link here, so a client router can take the
   * navigation over. Without it the browser follows the link. A modified press
   * (new tab, new window) always stays with the browser.
   */
  onNavigate?: (href: string) => void
}

type Group = [type: string, apps: SwitcherApp[]]

const TRIGGER = 'h-8 shrink-0 gap-1.5 px-2 pointer-coarse:h-10'

// Types keep the order their first app arrives in.
function groupByType(apps: SwitcherApp[]) {
  const groups: Group[] = []
  for (const app of apps) {
    const group = groups.find(([type]) => type === app.type)
    if (group) {
      group[1].push(app)
    } else {
      groups.push([app.type, [app]])
    }
  }
  return groups
}

function Glyph({ icon: Icon }: { icon?: SwitcherApp['icon'] }) {
  return Icon ? <Icon className='size-4 shrink-0' /> : null
}

function opensElsewhere(event: MouseEvent) {
  return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
}

interface AppMenuProps extends Omit<AppSwitcherProps, 'apps'> {
  groups: Group[]
  /** Name each group; off for a menu that holds a single type. */
  headings: boolean
  trigger: ReactElement
  children: ReactNode
}

// The same list the space selector opens: a search with a plus beside it,
// rows that are real links, the stock check on the open one.
function AppMenu({ groups, headings, activeId, createHref, onNavigate, trigger, children }: AppMenuProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

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

  // The link stops the click from reaching the cmdk item, otherwise a
  // ctrl-click would open a tab AND move this one; Enter goes through the item.
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
      <PopoverTrigger render={trigger}>{children}</PopoverTrigger>
      <PopoverContent className='w-64 gap-0 p-0' side='bottom' align='start'>
        <Command className='p-0'>
          <div className='flex items-center pr-1 *:data-[slot=command-input-wrapper]:flex-1'>
            <CommandInput value={query} onValueChange={setQuery} placeholder='Search apps…' />
            {createHref && (
              <a
                href={createHref}
                aria-label='Add app'
                title='Add app'
                className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'mt-1 size-8 shrink-0')}
                onClick={linkClick(createHref)}
              >
                <Plus />
              </a>
            )}
          </div>
          <CommandList>
            <CommandEmpty>No apps found.</CommandEmpty>
            {groups.map(([type, items]) => (
              <CommandGroup key={type} heading={headings ? type : undefined}>
                {items.map((app) => (
                  <CommandItem
                    key={app.id}
                    value={`${app.label} ${app.type} ${app.id}`}
                    data-checked={app.id === activeId}
                    className='p-0 pr-2'
                    onSelect={() => go(app.href)}
                  >
                    <a
                      href={app.href}
                      aria-current={app.id === activeId ? 'page' : undefined}
                      className='flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5'
                      onClick={linkClick(app.href)}
                    >
                      <Glyph icon={app.icon} />
                      <span className='truncate'>{app.label}</span>
                    </a>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The apps of a space as one entry per type across the title bar. A type with
 * a single app is a plain link; a type with several opens a searchable list of
 * them. The open type is highlighted; which of its apps is open is marked in
 * its list. When the bar is too narrow
 * for the row, the whole thing folds into one list grouped by type.
 */
export function AppSwitcher({ apps, activeId, createHref, onNavigate }: AppSwitcherProps) {
  const groups = groupByType(apps)
  const active = apps.find((app) => app.id === activeId)
  const menu = { activeId, createHref, onNavigate }

  return (
    <div className='@container/apps min-w-0 flex-1'>
      <nav aria-label='Apps' className='hidden items-center gap-0.5 @lg/apps:flex'>
        {groups.map(([type, items]) => {
          const current = items.find((app) => app.id === activeId)
          const shown = current ?? items[0]
          const variant = current ? 'secondary' : 'ghost'
          // The bar names types; which app of the type is open is the check
          // in its list.
          const label = type

          if (items.length === 1) {
            return (
              <a
                key={type}
                href={shown.href}
                aria-current={current ? 'page' : undefined}
                className={cn(buttonVariants({ variant, size: 'sm' }), TRIGGER)}
                onClick={(event) => {
                  if (onNavigate && !opensElsewhere(event)) {
                    event.preventDefault()
                    onNavigate(shown.href)
                  }
                }}
              >
                <Glyph icon={shown.icon} />
                {label}
              </a>
            )
          }
          return (
            <AppMenu
              key={type}
              {...menu}
              groups={[[type, items]]}
              headings={false}
              trigger={<Button variant={variant} size='sm' className={TRIGGER} />}
            >
              <Glyph icon={shown.icon} />
              <span className='max-w-40 truncate'>{label}</span>
              <ChevronDown className='size-3.5 text-muted-foreground' />
            </AppMenu>
          )
        })}
      </nav>

      <div className='@lg/apps:hidden'>
        <AppMenu
          {...menu}
          groups={groups}
          headings
          trigger={<Button variant='ghost' size='sm' className={cn(TRIGGER, 'max-w-full')} />}
        >
          {active ? <Glyph icon={active.icon} /> : <LayoutGrid className='size-4' />}
          <span className='min-w-0 truncate'>{active?.type ?? 'Apps'}</span>
          <ChevronDown className='size-3.5 text-muted-foreground' />
        </AppMenu>
      </div>
    </div>
  )
}
