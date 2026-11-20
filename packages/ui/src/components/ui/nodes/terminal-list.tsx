'use client'

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, ChevronsUpDown, LoaderCircle, SquareTerminal, X } from 'lucide-react'

import { Button } from '../button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '../command'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { RowContextMenu } from '../utils/row-context-menu'
import { cn } from 'cn'

export interface TerminalListEntry {
  /** The host's address for the terminal. Opaque here; reported back on select and remove. */
  target: string
  /**
   * The terminal's one name, as the host names it everywhere: the node's name,
   * with which of its terminals it is when that is something else
   * ("web · web-1"), or what an app calls it ("my-app · main").
   */
  name: string
  /** Known but not reachable right now. Still listed, so a saved choice is shown rather than dropped. */
  unavailable?: boolean
}

/** A space or an app a source sits in: `id` groups, `name` is shown. */
export interface TerminalListPlace {
  id: string
  name: string
}

export interface TerminalListSource {
  /** Unique among the sources. */
  id: string
  /** The node's title or the app's name -- what the user called it. */
  name: string
  /** Its kind's icon. With `accent`, it is what tells the kinds apart. */
  icon?: LucideIcon
  /**
   * The colour its kind is drawn in on the canvas, any CSS colour. Left out
   * (an app), the icon takes the text colour.
   */
  accent?: string
  /** The space it lives in. Sources are sectioned by it once they come from more than one. */
  space?: TerminalListPlace
  /** The graph a node is on, or the app itself: its terminals are grouped under it within the space. */
  app?: TerminalListPlace
  terminals: TerminalListEntry[]
  /** Its terminals are still being discovered. The rest of the list does not wait for it. */
  loading?: boolean
}

export interface TerminalListProps {
  sources: TerminalListSource[]
  /** The chosen terminal's target; its row carries the check. */
  value?: string
  /** The primary action, a press or Enter on a row. */
  onSelect?: (target: string) => void
  /** When given, every row can be removed: an X on the row and Remove in its context menu. */
  onRemove?: (target: string) => void
  /** A search field over terminal, node, app and space names. */
  searchable?: boolean
  /** Rows go inert, e.g. while the host is applying the last press. */
  disabled?: boolean
  /** The sources themselves are not known yet. Until one arrives the list says
   * it is loading rather than that there are no terminals. */
  loading?: boolean
  /** Rows drawn before the sources -- a picker's None. */
  leading?: ReactNode
  className?: string
}

// A source as shown: the source itself, and those of its terminals the search kept.
interface ShownSource {
  source: TerminalListSource
  terminals: TerminalListEntry[]
}

interface AppGroup {
  key: string
  app?: TerminalListPlace
  sources: ShownSource[]
}

interface SpaceSection {
  key: string
  space?: TerminalListPlace
  apps: AppGroup[]
}

// Insertion order, as the host sent it: spaces in the order their first source
// came, apps likewise within each. Arrays rather than Maps: a generic on `new`
// in an expression position breaks the preview's transform.
function sectionBySpaceAndApp(shown: ShownSource[]): SpaceSection[] {
  const sections: SpaceSection[] = []
  for (const item of shown) {
    const spaceKey = item.source.space?.id ?? ''
    let section = sections.find((candidate) => candidate.key === spaceKey)
    if (!section) {
      section = { key: spaceKey, space: item.source.space, apps: [] }
      sections.push(section)
    }
    // A source in no app is a group of its own, without a heading.
    const appKey = item.source.app ? `app:${item.source.app.id}` : `source:${item.source.id}`
    const group = section.apps.find((candidate) => candidate.key === appKey)
    if (group) {
      group.sources.push(item)
    } else {
      section.apps.push({ key: appKey, app: item.source.app, sources: [item] })
    }
  }
  return sections
}

function includes(text: string | undefined, needle: string): boolean {
  return Boolean(text?.toLowerCase().includes(needle))
}

// A source with nothing to pick is left out: it would be a row that cannot be
// chosen. A source whose own name, app or space matches keeps every terminal;
// otherwise only the terminals that match stay. One still loading stays while
// searching, since what it has not reported yet may match.
function filterSources(sources: TerminalListSource[], query: string): ShownSource[] {
  const needle = query.trim().toLowerCase()
  return sources.flatMap((source) => {
    if (source.terminals.length === 0 && !source.loading) {
      return []
    }
    if (
      !needle ||
      includes(source.name, needle) ||
      includes(source.app?.name, needle) ||
      includes(source.space?.name, needle)
    ) {
      return [{ source, terminals: source.terminals }]
    }
    const terminals = source.terminals.filter((terminal) => includes(terminal.name, needle))
    return terminals.length > 0 || source.loading ? [{ source, terminals }] : []
  })
}

/**
 * The terminals a host can reach, grouped by space (once there is more than
 * one) and within it by app: the graph a node is on, or the app offering them.
 * Every row is one terminal under its one name, with its kind's icon in its
 * kind's colour, so a node's several terminals are told apart by name and
 * nothing is said twice. Built on the kit's Command, so arrows and Enter move
 * and choose.
 */
export function TerminalList({
  sources,
  value,
  onSelect,
  onRemove,
  searchable = true,
  disabled,
  loading,
  leading,
  className,
}: TerminalListProps) {
  const [query, setQuery] = useState('')
  const shown = filterSources(sources, query)
  const sections = sectionBySpaceAndApp(shown)
  const sectioned = sections.length > 1
  const nothingAtAll = filterSources(sources, '').length === 0

  return (
    // Filtering is this component's own: it matches a source's terminals by the
    // source's, app's and space's names too, which cmdk's per-item matching
    // cannot express.
    <Command shouldFilter={false} className={cn('bg-transparent p-0', className)}>
      {searchable ? <CommandInput value={query} onValueChange={setQuery} placeholder='Search terminals…' /> : null}
      {/* The list takes whatever height the root is given and scrolls inside it. */}
      <CommandList className='max-h-none min-h-0 flex-1'>
        {leading ? <CommandGroup>{leading}</CommandGroup> : null}
        {nothingAtAll ? (
          loading ? (
            <ListNote>
              <LoaderCircle className='size-4 animate-spin' />
              Loading terminals…
            </ListNote>
          ) : (
            <ListNote>No terminals found.</ListNote>
          )
        ) : shown.length === 0 ? (
          <ListNote>Nothing matches that.</ListNote>
        ) : (
          sections.map((section) => (
            <div key={section.key}>
              {sectioned ? (
                // 10px is off the type scale, so it is an inline size rather
                // than an arbitrary class the preview would never generate.
                <div
                  className='px-3 pt-2 pb-0.5 uppercase tracking-wider text-muted-foreground'
                  style={{ fontSize: 10 }}
                >
                  {section.space?.name || 'Other'}
                </div>
              ) : null}
              {section.apps.map((group) => (
                <CommandGroup key={group.key} heading={group.app ? group.app.name : undefined}>
                  {group.sources.map(({ source, terminals }) => (
                    <SourceRows
                      key={source.id}
                      source={source}
                      terminals={terminals}
                      value={value}
                      onSelect={onSelect}
                      onRemove={onRemove}
                      disabled={disabled}
                    />
                  ))}
                </CommandGroup>
              ))}
            </div>
          ))
        )}
      </CommandList>
    </Command>
  )
}

function SourceRows({
  source,
  terminals,
  ...rowProps
}: {
  source: TerminalListSource
  terminals: TerminalListEntry[]
} & Omit<TerminalRowProps, 'entry' | 'source'>) {
  return (
    <>
      {terminals.map((entry) => (
        <TerminalRow key={entry.target} entry={entry} source={source} {...rowProps} />
      ))}
      {source.loading ? (
        <div className='flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground'>
          <LoaderCircle className='size-3.5 animate-spin' />
          <span className='truncate'>{source.name}…</span>
        </div>
      ) : null}
    </>
  )
}

// A source's icon in its kind's colour, the way the canvas draws the node.
// Muted, it drops the colour too: a terminal that is not running is not
// pointed out by its kind.
function SourceIcon({
  icon,
  accent,
  muted,
  className,
}: {
  icon?: LucideIcon
  accent?: string
  muted?: boolean
  className?: string
}) {
  const Icon = icon ?? SquareTerminal
  return (
    <Icon
      className={cn('shrink-0', muted && 'text-muted-foreground', className)}
      style={accent && !muted ? { color: accent } : undefined}
    />
  )
}

function ListNote({ children }: { children: ReactNode }) {
  return (
    <div className='flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground'>{children}</div>
  )
}

interface TerminalRowProps {
  entry: TerminalListEntry
  source: TerminalListSource
  value?: string
  onSelect?: (target: string) => void
  onRemove?: (target: string) => void
  disabled?: boolean
}

function TerminalRow({ entry, source, value, onSelect, onRemove, disabled }: TerminalRowProps) {
  const item = (
    <CommandItem
      value={entry.target}
      data-checked={entry.target === value}
      disabled={disabled}
      onSelect={() => onSelect?.(entry.target)}
      // The stock item ends in a selection check, invisible but still 16px
      // wide. With no value to mark it is only a gap, so it is hidden.
      className={cn('gap-2 pointer-coarse:py-2.5', value === undefined && '*:[svg:last-child]:hidden')}
      // Suppresses the browser's own long-press furniture so the context
      // menu's press is the only thing that gesture does.
      style={{ WebkitTouchCallout: 'none' }}
    >
      <SourceIcon icon={source.icon} accent={source.accent} muted={entry.unavailable} className='size-4' />
      <span className={cn('min-w-0 flex-1 truncate', entry.unavailable && 'text-muted-foreground')}>{entry.name}</span>
      {entry.unavailable ? <span className='shrink-0 text-xs text-muted-foreground'>unavailable</span> : null}
      {onRemove ? (
        <Button
          type='button'
          variant='ghost'
          size='icon-xs'
          aria-label='Remove'
          title='Remove'
          disabled={disabled}
          className='pointer-coarse:size-8'
          onClick={(event) => {
            event.stopPropagation()
            onRemove(entry.target)
          }}
        >
          <X />
        </Button>
      ) : null}
    </CommandItem>
  )
  return (
    <RowContextMenu
      entries={
        onRemove
          ? [{ label: 'Remove', icon: <X className='size-3' />, destructive: true, onSelect: () => onRemove(entry.target) }]
          : undefined
      }
    >
      {item}
    </RowContextMenu>
  )
}

/** How much of a terminal's path is shown: Space › App › Terminal, Space › … › Terminal, or Terminal. */
export type TerminalPathForm = 'full' | 'short' | 'name'

/**
 * The longest form whose natural width fits `available` px. A path without a
 * space has only its name to show.
 */
export function terminalPathForm(available: number, widths: { full: number; short: number }): TerminalPathForm {
  if (widths.full <= available) {
    return 'full'
  }
  if (widths.short <= available) {
    return 'short'
  }
  return 'name'
}

/** One part of a shown path; `gap` stands for the app a short form leaves out. */
export interface TerminalPathSegment {
  part: 'space' | 'app' | 'gap' | 'name'
  text: string
}

/** The segments of one form. An app named like its terminal adds nothing and is left out. */
export function terminalPathSegments(
  form: TerminalPathForm,
  { space, app, name }: { space?: string; app?: string; name: string },
): TerminalPathSegment[] {
  const last: TerminalPathSegment = { part: 'name', text: name }
  if (form === 'name') {
    return [last]
  }
  const head: TerminalPathSegment[] = space ? [{ part: 'space', text: space }] : []
  if (!app || app === name) {
    return [...head, last]
  }
  if (form === 'short' && space) {
    return [...head, { part: 'gap', text: '…' }, last]
  }
  return [...head, { part: 'app', text: app }, last]
}

function PathText({ segments }: { segments: TerminalPathSegment[] }) {
  return (
    <>
      {segments.map((segment) =>
        segment.part === 'name' ? (
          <span key={segment.part} className='min-w-0 truncate'>
            {segment.text}
          </span>
        ) : (
          <span key={segment.part} className='flex shrink-0 items-center gap-1 text-muted-foreground'>
            {segment.text}
            <ChevronRight className='size-3 shrink-0' />
          </span>
        ),
      )}
    </>
  )
}

export interface TerminalPathProps {
  /** The terminal's one name. */
  name: string
  /** The space it is in. */
  space?: string
  /** The graph its node is on, or the app offering it. */
  app?: string
  /** Its kind's icon, in `accent`. */
  icon?: LucideIcon
  accent?: string
  /** Not running: the icon loses its colour and the text is muted. */
  muted?: boolean
  className?: string
}

/**
 * A terminal shown with where it is: Space › App › Terminal while that fits,
 * Space › … › Terminal when it does not, then the terminal's name alone,
 * truncated. What fits is measured against the width its container gives it,
 * not the window's, and follows that width as it changes. The full path is on
 * hover whenever a part of it is hidden.
 *
 * It fills the width its container gives it (a flex row, a block): in a
 * container that sizes itself to its content it would size itself to the full
 * path and never shorten.
 */
export function TerminalPath({ name, space, app, icon, accent, muted, className }: TerminalPathProps) {
  const textRef = useRef<HTMLSpanElement>(null)
  const fullRef = useRef<HTMLSpanElement>(null)
  const shortRef = useRef<HTMLSpanElement>(null)
  const [form, setForm] = useState<TerminalPathForm>('full')
  const parts = { space, app, name }
  const full = terminalPathSegments('full', parts)
  const short = terminalPathSegments('short', parts)
  const shown = terminalPathSegments(form, parts)

  useLayoutEffect(() => {
    const text = textRef.current
    if (!text || typeof ResizeObserver === 'undefined') {
      return
    }
    const measure = () =>
      setForm(
        terminalPathForm(text.clientWidth, {
          full: fullRef.current?.scrollWidth ?? 0,
          short: shortRef.current?.scrollWidth ?? 0,
        }),
      )
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(text)
    return () => observer.disconnect()
  }, [space, app, name])

  const hidden = shown.length < full.length || shown.some((segment) => segment.part === 'gap')
  return (
    <span
      className={cn('flex min-w-0 flex-1 items-center gap-1.5', muted && 'text-muted-foreground', className)}
      title={hidden ? full.map((segment) => segment.text).join(' › ') : undefined}
    >
      <SourceIcon icon={icon} accent={accent} muted={muted} className='size-4' />
      {/* Its width is what the container leaves, whatever form it shows. */}
      <span ref={textRef} className='relative flex min-w-0 flex-1 basis-0 items-center gap-1 overflow-hidden'>
        <PathText segments={shown} />
        {/* The two longer forms, laid out unseen at their natural widths. */}
        <span
          ref={fullRef}
          aria-hidden
          className='pointer-events-none invisible absolute top-0 left-0 flex items-center gap-1 whitespace-nowrap'
        >
          <PathText segments={full} />
        </span>
        <span
          ref={shortRef}
          aria-hidden
          className='pointer-events-none invisible absolute top-0 left-0 flex items-center gap-1 whitespace-nowrap'
        >
          <PathText segments={short} />
        </span>
      </span>
    </span>
  )
}

export interface TerminalPickerProps {
  sources: TerminalListSource[]
  /** The chosen terminal's target, or '' for none. */
  value?: string
  onValueChange: (target: string) => void
  /** Offers an explicit None, reported as ''. */
  allowNone?: boolean
  placeholder?: string
  disabled?: boolean
  /** The sources themselves are not known yet -- see Terminal List. */
  loading?: boolean
  /**
   * How to show a chosen target that no source lists -- a saved choice whose
   * container stopped. Without it the target itself is shown.
   */
  renderMissing?: (target: string) => ReactNode
}

function findEntry(sources: TerminalListSource[], target: string | undefined) {
  for (const source of sources) {
    const entry = source.terminals.find((candidate) => candidate.target === target)
    if (entry) {
      return { source, entry }
    }
  }
  return null
}

/**
 * Choosing one terminal: a trigger showing the choice with where it is (see
 * Terminal Path), opening Terminal List with its search in a popover as wide
 * as the trigger.
 *
 * A chosen target no source lists yet is shown as chosen, and marked
 * unavailable only once every source has answered.
 */
export function TerminalPicker({
  sources,
  value,
  onValueChange,
  allowNone,
  placeholder = 'Select a terminal',
  disabled,
  loading,
  renderMissing,
}: TerminalPickerProps) {
  const [open, setOpen] = useState(false)
  const found = findEntry(sources, value)
  const answered = !loading && sources.every((source) => !source.loading)

  function choose(target: string) {
    setOpen(false)
    onValueChange(target)
  }

  const label = found ? (
    <TerminalPath
      name={found.entry.name}
      space={found.source.space?.name}
      app={found.source.app?.name}
      icon={found.source.icon}
      accent={found.source.accent}
      muted={found.entry.unavailable}
    />
  ) : value ? (
    <>
      {renderMissing ? (
        renderMissing(value)
      ) : (
        <>
          <SquareTerminal className='text-muted-foreground' />
          <span className='min-w-0 flex-1 truncate text-left'>{value}</span>
        </>
      )}
      {answered ? <span className='shrink-0 text-xs text-muted-foreground'>unavailable</span> : null}
    </>
  ) : (
    <span className='truncate text-muted-foreground'>{allowNone ? 'None' : placeholder}</span>
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={<Button variant='outline' className='w-full min-w-0 justify-start font-normal' />}
      >
        {label}
        <ChevronsUpDown className='ml-auto text-muted-foreground' />
      </PopoverTrigger>
      <PopoverContent className='w-(--anchor-width) min-w-72 gap-0 p-0' align='start'>
        <TerminalList
          sources={sources}
          value={value}
          onSelect={choose}
          loading={loading}
          className='max-h-96'
          leading={
            allowNone ? (
              <CommandItem value='__none__' data-checked={!value} onSelect={() => choose('')}>
                None
              </CommandItem>
            ) : undefined
          }
        />
      </PopoverContent>
    </Popover>
  )
}
