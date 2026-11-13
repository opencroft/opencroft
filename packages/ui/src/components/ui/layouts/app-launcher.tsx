import { Command as CommandPrimitive } from 'cmdk'
import { cn } from 'cn'
import { History, SearchIcon } from 'lucide-react'
import { type ComponentType, type MouseEvent, type ReactNode, useMemo, useRef, useState } from 'react'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandItem, CommandList } from 'ui/components/ui/command'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/components/ui/empty'
import { InputGroup, InputGroupAddon } from 'ui/components/ui/input-group'
import { Kbd, KbdGroup } from 'ui/components/ui/kbd'
import { ScrollArea } from 'ui/components/ui/layout/scroll-area'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from 'ui/components/ui/tooltip'

import { groupBySpace, groupByType, matchesSearch, searchSpaces, type TypeGroup } from './app-launcher-groups'
import { type SelectorSpace, SpaceSelectorIcon } from './space-selector'

type Icon = ComponentType<{ className?: string }>

/** An app of some space, as the launcher lists it. */
export interface AppLauncherApp {
  id: string
  spaceSlug: string
  label: string
  href: string
  icon?: Icon
  /** What kind of app it is (docs, graph, tasks); searchable alongside the name. */
  type: string
}

/** A page outside the spaces, such as the chats or the settings. */
export interface AppLauncherPage {
  label: string
  href: string
  icon: Icon
}

export interface AppLauncherSearchProps {
  spaces: SelectorSpace[]
  /** The space the reader is in, or came from: the space whose apps it opens on. */
  currentSlug?: string
  /** Every space's apps. */
  apps: AppLauncherApp[]
  /** The apps opened before, most recent first, the open one left out. */
  recent: AppLauncherApp[]
  activeAppId?: string
  /** Pages outside the spaces; found by searching. */
  pages: AppLauncherPage[]
  hrefFor: (slug: string) => string
  /**
   * A plain press or Enter on any link here, so a client router can take the
   * navigation over. Without it the browser follows the link. A modified press
   * (new tab, new window) always stays with the browser.
   */
  onNavigate?: (href: string) => void
  /** Called before any navigation from here, modified presses included; a dialog closes on it. */
  onChoose?: () => void
  /** The keys of the shortcut that opens it (`['⌘', 'K']`), shown at the end of the search from md up. */
  shortcut?: string[]
  /**
   * What it shows with nothing typed until Recent or a space is chosen:
   * Recent (the default) or the current space's apps.
   */
  opensOn?: 'recent' | 'space'
  /** The apps are still on their way: the list stays blank rather than saying there are none. */
  loading?: boolean
  className?: string
}

/**
 * The highlighted row's value while no row is highlighted. cmdk highlights
 * the first row whenever its value is empty, so "none" has to be a value of
 * its own; every row's value has a `group:` prefix, so this names none.
 */
const NO_ROW = 'none'

/** What the list shows with nothing typed: the recent apps, or one space's. */
type Shelf = { recent: true } | { recent: false; slug: string }

/** A row of the list: a link. */
interface Row {
  value: string
  href: string
  glyph: ReactNode
  label: string
  caption?: string
  checked?: boolean
}

function opensElsewhere(event: MouseEvent) {
  return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
}

/**
 * One place to go anywhere from: the search on top; under it, with nothing
 * typed, a narrow column of Recent and the spaces as icons, named by their
 * tooltips, beside the chosen one's apps. It opens on Recent, or on the
 * current space when `opensOn` asks. Recent is grouped by space, the space
 * used last first, then by type; a space's apps are grouped by type. The
 * types go in alphabetical order, the apps by name inside each.
 * Typing replaces both with the results, grouped as Recent is with the space
 * itself leading its group, then the pages outside the spaces.
 *
 * The same search is the phone's Apps page and the desktop's Cmd+K dialog.
 */
export function AppLauncherSearch({
  spaces,
  currentSlug,
  apps,
  recent,
  activeAppId,
  pages,
  hrefFor,
  onNavigate,
  onChoose,
  shortcut,
  opensOn = 'recent',
  loading = false,
  className,
}: AppLauncherSearchProps) {
  // The rows are filtered here, not by cmdk: its own filter reorders them by
  // score, and the list keeps the groups' order, which is also the order the
  // arrow keys move in.
  const [query, setQuery] = useState('')
  const searching = query !== ''
  const [chosen, setChosen] = useState<Shelf | undefined>()
  // Nothing is highlighted when it opens, so Enter opens nothing until the
  // reader moves to a row (arrows, pointer) or types, which highlights the
  // first result.
  const [highlighted, setHighlighted] = useState(NO_ROW)
  const inputRef = useRef<HTMLInputElement>(null)
  const orderedSpaces = useMemo(
    () => [...spaces.filter((space) => space.pinned), ...spaces.filter((space) => !space.pinned)],
    [spaces],
  )
  const spacesBySlug = useMemo(() => new Map(spaces.map((space) => [space.slug, space])), [spaces])
  const appsBySpace = useMemo(() => groupBySpace(apps), [apps])
  const recentBySpace = useMemo(() => groupBySpace(recent), [recent])
  const found = useMemo(
    () => (searching ? searchSpaces(orderedSpaces, appsBySpace, query) : []),
    [searching, orderedSpaces, appsBySpace, query],
  )
  const foundPages = searching ? pages.filter((page) => matchesSearch(query, [page.label])) : []
  // Decided without the apps, so nothing moves when they arrive.
  const shelf: Shelf =
    chosen ??
    (opensOn === 'recent' ? { recent: true } : { recent: false, slug: currentSlug ?? orderedSpaces[0]?.slug ?? '' })

  function go(href: string) {
    onChoose?.()
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
        onChoose?.()
      }
    }
  }

  function row({ value, href, glyph, label, caption, checked = false }: Row) {
    return (
      <CommandItem
        key={value}
        value={value}
        data-checked={checked}
        className='p-0 pr-2'
        onSelect={() => go(href)}
      >
        <a
          href={href}
          aria-current={checked ? 'page' : undefined}
          className='flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 pointer-coarse:py-2.5'
          onClick={linkClick(href)}
        >
          {glyph}
          <span className='min-w-0 flex-1 truncate'>{label}</span>
          {caption && <span className='max-w-[40%] shrink-0 truncate text-xs text-muted-foreground'>{caption}</span>}
        </a>
      </CommandItem>
    )
  }

  function appRow(app: AppLauncherApp, group: string) {
    const Glyph = app.icon
    return row({
      value: `${group}:${app.id}`,
      href: app.href,
      glyph: Glyph ? <Glyph className='size-4 shrink-0' /> : null,
      label: app.label,
      checked: app.id === activeAppId,
    })
  }

  // One group per type, headed by the type's name.
  function typeGroups(types: TypeGroup[], group: string) {
    return types.map(({ type, apps: typeApps }) => (
      <CommandGroup key={type} heading={type}>
        {typeApps.map((app) => appRow(app, group))}
      </CommandGroup>
    ))
  }

  function spaceHeading(space: SelectorSpace) {
    return (
      <span className='flex items-center gap-1.5'>
        <SpaceSelectorIcon icon={space.icon} className='size-3.5' />
        {space.name}
      </span>
    )
  }

  // One of the column's icons, named by its tooltip.
  function railButton(key: string, pressed: boolean, onClick: () => void, glyph: ReactNode, label: string) {
    return (
      <Tooltip key={key}>
        <TooltipTrigger
          render={
            <button
              type='button'
              aria-label={label}
              aria-pressed={pressed}
              onClick={onClick}
              className={cn(
                'flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted outline-none hover:ring-2 hover:ring-ring/40 focus-visible:ring-3 focus-visible:ring-ring/50',
                pressed && 'ring-2 ring-primary! ring-offset-2 ring-offset-background',
              )}
            />
          }
        >
          {glyph}
        </TooltipTrigger>
        <TooltipContent side='right'>{label}</TooltipContent>
      </Tooltip>
    )
  }

  // Recent on top, then every space, each a tile of one size; the column
  // scrolls on its own when the spaces outgrow it, its padding holding the
  // chosen tile's ring. Names show at once on hover: the icons carry no text
  // of their own, so the tooltip is how they are read. Typing while one of
  // them has focus goes to the search, as it would anywhere else here.
  const rail = (
    <TooltipProvider delay={0}>
      <nav
        aria-label='Spaces'
        className='flex flex-col items-center gap-2 py-2 pr-1 pl-2 in-data-has-overflow-y:pr-3.5'
        onKeyDown={(event) => {
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            inputRef.current?.focus()
          }
        }}
      >
        {railButton(
          'recent',
          shelf.recent,
          () => setChosen({ recent: true }),
          <History className='size-5' />,
          'Recent',
        )}
        {orderedSpaces.map((space) =>
          railButton(
            space.slug,
            !shelf.recent && shelf.slug === space.slug,
            () => setChosen({ recent: false, slug: space.slug }),
            <SpaceSelectorIcon icon={space.icon} className='size-10' />,
            space.name,
          ),
        )}
      </nav>
    </TooltipProvider>
  )

  const shelfSpace = shelf.recent ? undefined : spacesBySlug.get(shelf.slug)
  const shelfApps = shelf.recent ? recent : (appsBySpace.get(shelf.slug) ?? [])
  // The shelf is named once, at the list's head; the column already shows
  // its icon.
  const browsing = (
    <>
      <div className='truncate px-2 pt-2 pb-1 text-base font-semibold'>
        {shelf.recent ? 'Recent' : (shelfSpace?.name ?? shelf.slug)}
      </div>
      {loading ? null : shelfApps.length === 0 ? (
        <Empty className='p-8'>
          <EmptyHeader>
            <EmptyTitle className='text-sm'>{shelf.recent ? 'Nothing opened yet' : 'No apps here yet'}</EmptyTitle>
            <EmptyDescription>
              {shelf.recent ? 'The apps you open show up here.' : 'Apps added to this space show up here.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : shelf.recent ? (
        // The spaces in the order they were last used in, each with its apps
        // by type.
        [...recentBySpace].flatMap(([slug, spaceApps]) => {
          const space = spacesBySlug.get(slug)
          return space ? (
            <CommandGroup key={slug} heading={spaceHeading(space)}>
              {typeGroups(groupByType(spaceApps), 'recent')}
            </CommandGroup>
          ) : (
            []
          )
        })
      ) : (
        typeGroups(groupByType(shelfApps), 'space')
      )}
    </>
  )

  // One group per space, headed by it, so a word found in several spaces
  // reads as which space has what; the space itself leads its group, its
  // apps follow by type.
  const results = (
    <>
      {found.map(({ space, spaceMatches, types }) => (
        <CommandGroup key={space.slug} heading={spaceHeading(space)}>
          {spaceMatches &&
            row({
              value: `space:${space.slug}`,
              href: hrefFor(space.slug),
              glyph: <SpaceSelectorIcon icon={space.icon} className='size-4' />,
              label: space.name,
              caption: 'Space',
              checked: space.slug === currentSlug,
            })}
          {typeGroups(types, 'app')}
        </CommandGroup>
      ))}
      {foundPages.length > 0 && (
        <CommandGroup heading='Pages'>
          {foundPages.map((page) =>
            row({
              value: `page:${page.href}`,
              href: page.href,
              glyph: <page.icon className='size-4 shrink-0' />,
              label: page.label,
            }),
          )}
        </CommandGroup>
      )}
    </>
  )

  return (
    <Command shouldFilter={false} value={highlighted} onValueChange={setHighlighted} className={className}>
      {/* The Command Input's own field (its wrapper, group and classes) with a
          second addon at the end for the shortcut, which the stock input has
          no slot for. */}
      <div data-slot='command-input-wrapper' className='p-1 pb-0'>
        <InputGroup className='h-8! rounded-lg! border-input/30 bg-field shadow-none! *:data-[slot=input-group-addon]:pl-2!'>
          <CommandPrimitive.Input
            ref={inputRef}
            data-slot='command-input'
            value={query}
            onValueChange={setQuery}
            placeholder='Search spaces, apps and pages…'
            className='w-full text-sm outline-hidden'
          />
          <InputGroupAddon>
            <SearchIcon className='size-4 shrink-0 opacity-50' />
          </InputGroupAddon>
          {shortcut && (
            <InputGroupAddon align='inline-end' className='max-md:hidden'>
              <KbdGroup>
                {shortcut.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </KbdGroup>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      {/* Browsing puts the column beside the list; the results take the
          whole width. Each scrolls on its own, in the kit's scroll area; the
          list grows with its content up to what its container leaves it.
          While an area overflows (Base UI marks it `data-has-overflow-y`)
          its content keeps clear of the scrollbar, which overlays its edge. */}
      <div className={cn('flex min-h-0 flex-1', !searching && '-mx-1 mt-1 -mb-1')}>
        {!searching && <ScrollArea className='shrink-0'>{rail}</ScrollArea>}
        <ScrollArea className='min-w-0 flex-1'>
          <CommandList
            className={cn('max-h-none overflow-visible in-data-has-overflow-y:pr-3', !searching && 'p-1 pl-0')}
          >
            {searching && <CommandEmpty>Nothing found.</CommandEmpty>}
            {searching ? results : browsing}
          </CommandList>
        </ScrollArea>
      </div>
    </Command>
  )
}

export interface AppLauncherProps extends Omit<AppLauncherSearchProps, 'onChoose' | 'className'> {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The App Launcher as a dialog over the page, for a keyboard shortcut. It mounts
 * its search afresh each time it opens, so it opens on an empty search and,
 * unless told otherwise, the current space: the dialog is opened from where
 * the reader works, the page is where they go to come back.
 */
export function AppLauncher({ open, onOpenChange, ...search }: AppLauncherProps) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title='App Launcher'
      description='Search spaces, apps and pages'
      className='top-(--app-launcher-gap) max-h-[calc(100dvh-2*var(--app-launcher-gap))] gap-0 [--app-launcher-gap:clamp(1rem,25dvh_-_6rem,100dvh/6)] max-md:[--app-launcher-gap:1rem] sm:max-w-xl 2xl:max-w-2xl'
    >
      {/* As tall as its list, at most down to as far above the viewport's
          bottom edge as its top sits below the top edge; past that the list
          scrolls. The gap shrinks faster than the window does: a sixth of a
          tall window, a quarter of the height less 6rem below that, so a
          short window keeps its room for the list, and never under 1rem
          (all of it on a phone). Wider than a plain dialog, and wider again
          on a large screen, for the column beside the list. */}
      <AppLauncherSearch opensOn='space' {...search} onChoose={() => onOpenChange(false)} className='min-h-0 flex-1' />
    </CommandDialog>
  )
}

/** The App Launcher as a page of its own: the search on top, the list taking the rest of the height. */
export function AppLauncherScreen({ className, ...search }: Omit<AppLauncherSearchProps, 'onChoose'>) {
  return <AppLauncherSearch {...search} className={cn('h-full rounded-none! bg-background', className)} />
}
