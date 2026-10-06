'use client'

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { ChevronsUpDown, LoaderCircle, SquareTerminal, X } from 'lucide-react'

import { Button } from '../button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '../command'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { RowContextMenu } from '../utils/row-context-menu'
import { cn } from 'cn'

export interface TerminalListEntry {
  /** The host's address for the terminal. Opaque here; reported back on select and remove. */
  target: string
  /**
   * What tells it apart from the other terminals of the same node or app: a
   * container, a worktree. Left out only for the owner's one and only terminal.
   */
  name?: string
  /** Known but not reachable right now. Still listed, so a saved choice is shown rather than dropped. */
  unavailable?: boolean
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
  space?: string
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

interface SpaceSection {
  space: string
  sources: ShownSource[]
}

// Insertion order, as the host sent it. An array rather than a Map: a generic
// on `new` in an expression position breaks the preview's transform.
function sectionBySpace(shown: ShownSource[]): SpaceSection[] {
  const sections: SpaceSection[] = []
  for (const item of shown) {
    const space = item.source.space ?? ''
    const section = sections.find((candidate) => candidate.space === space)
    if (section) {
      section.sources.push(item)
    } else {
      sections.push({ space, sources: [item] })
    }
  }
  return sections
}

function includes(text: string | undefined, needle: string): boolean {
  return Boolean(text?.toLowerCase().includes(needle))
}

// A source with nothing to pick is left out: it would be a row that cannot be
// chosen. A source whose own name or space matches keeps every terminal;
// otherwise only the terminals that match stay. One still loading stays while
// searching, since what it has not reported yet may match.
function filterSources(sources: TerminalListSource[], query: string): ShownSource[] {
  const needle = query.trim().toLowerCase()
  return sources.flatMap((source) => {
    if (source.terminals.length === 0 && !source.loading) {
      return []
    }
    if (!needle || includes(source.name, needle) || includes(source.space, needle)) {
      return [{ source, terminals: source.terminals }]
    }
    const terminals = source.terminals.filter((terminal) => includes(terminal.name, needle))
    return terminals.length > 0 || source.loading ? [{ source, terminals }] : []
  })
}

// How a terminal is named on its own, outside its owner's heading: the owner,
// preceded by which of the owner's terminals it is when it has a name. A list
// of chosen terminals may hold one terminal of an owner that has several, and
// that row still has to say which.
function ownTitle(source: TerminalListSource, entry: TerminalListEntry): string {
  return entry.name ? `${entry.name} · ${source.name}` : source.name
}

/**
 * The terminals a host can reach. Every row reads as the terminal of a named
 * node or of a named app, its kind told by the icon in its kind's colour.
 *
 * A source with one terminal is one row: which terminal it is when it is
 * named, then the owner. One with several is a heading in the same form over
 * its terminals' names, so the owner is written once rather than on every row.
 * Which form is decided by the source, not by what the search left of it, so
 * rows keep their shape while typing. Built on the kit's Command, so arrows and Enter move and choose.
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
  const sections = sectionBySpace(shown)
  const sectioned = sections.length > 1
  const nothingAtAll = filterSources(sources, '').length === 0

  const row = (entry: TerminalListEntry, label: ReactNode, source?: TerminalListSource) => (
    <TerminalRow
      key={entry.target}
      entry={entry}
      label={label}
      source={source}
      value={value}
      onSelect={onSelect}
      onRemove={onRemove}
      disabled={disabled}
    />
  )

  return (
    // Filtering is this component's own: it matches a source's terminals by the
    // source's name too, which cmdk's per-item matching cannot express.
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
            <div key={section.space}>
              {sectioned ? (
                // 10px is off the type scale, so it is an inline size rather
                // than an arbitrary class the preview would never generate.
                <div
                  className='px-3 pt-2 pb-0.5 uppercase tracking-wider text-muted-foreground'
                  style={{ fontSize: 10 }}
                >
                  {section.space || 'Other'}
                </div>
              ) : null}
              {section.sources.map(({ source, terminals }) =>
                source.terminals.length === 1 && !source.loading ? (
                  <CommandGroup key={source.id}>
                    {row(
                      source.terminals[0],
                      <span className='truncate'>{ownTitle(source, source.terminals[0])}</span>,
                      source,
                    )}
                  </CommandGroup>
                ) : (
                  <CommandGroup key={source.id} heading={<SourceHeading source={source} />}>
                    {terminals.map((entry) => row(entry, <span className='truncate'>{entry.name || 'Terminal'}</span>))}
                    {source.loading ? (
                      <div className='flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground'>
                        <LoaderCircle className='size-3.5 animate-spin' />
                        Loading…
                      </div>
                    ) : null}
                  </CommandGroup>
                ),
              )}
            </div>
          ))
        )}
      </CommandList>
    </Command>
  )
}

// A source's icon in its kind's colour, the way the canvas draws the node.
// Muted, it drops the colour too: a terminal that is not running is not
// pointed out by its kind.
function SourceIcon({
  source,
  muted,
  className,
}: {
  source?: TerminalListSource
  muted?: boolean
  className?: string
}) {
  const Icon = source?.icon ?? SquareTerminal
  return (
    <Icon
      className={cn('shrink-0', muted && 'text-muted-foreground', className)}
      style={source?.accent && !muted ? { color: source.accent } : undefined}
    />
  )
}

function SourceHeading({ source }: { source: TerminalListSource }) {
  return (
    <span className='flex min-w-0 items-center gap-1.5 text-foreground'>
      <SourceIcon source={source} className='size-3.5' />
      <span className='truncate'>{source.name}</span>
    </span>
  )
}

function ListNote({ children }: { children: ReactNode }) {
  return (
    <div className='flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground'>{children}</div>
  )
}

interface TerminalRowProps {
  entry: TerminalListEntry
  label: ReactNode
  /** Its icon is drawn for a source's only terminal; rows under a heading carry none, the heading has it. */
  source?: TerminalListSource
  value?: string
  onSelect?: (target: string) => void
  onRemove?: (target: string) => void
  disabled?: boolean
}

function TerminalRow({ entry, label, source, value, onSelect, onRemove, disabled }: TerminalRowProps) {
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
      <SourceIcon source={source} muted={entry.unavailable} className={cn('size-4', !source && 'opacity-0')} />
      <span className={cn('flex min-w-0 flex-1 items-center gap-1.5', entry.unavailable && 'text-muted-foreground')}>
        {label}
      </span>
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
 * Choosing one terminal: a trigger showing the choice the way the list names it,
 * opening Terminal List with its search in a popover as wide as the trigger.
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
    <>
      <SourceIcon source={found.source} muted={found.entry.unavailable} />
      <span className='truncate'>{ownTitle(found.source, found.entry)}</span>
    </>
  ) : value ? (
    <>
      <SquareTerminal className='text-muted-foreground' />
      <span className='truncate'>{renderMissing ? renderMissing(value) : value}</span>
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
