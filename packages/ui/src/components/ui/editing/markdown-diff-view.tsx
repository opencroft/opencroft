import { Fragment, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react'

import { cn } from 'cn'

import { DiffView, type LineSpan, lineDiff, wordDiff } from '../tool-views/diff-view'
import { type MarkdownDiffItem, markdownBlocks, markdownDiff, withDefinitions } from './markdown-diff'

// The longest rendered text of a block that is compared word by word. The word
// search stops after a few dozen differing words whatever the length, so a long
// block costs little; past this a block keeps only its frame's colour.
const MAX_BLOCK_TEXT = 20_000

// NodeFilter.SHOW_TEXT, as a value: the walker is made from the frame's own
// document, and nothing here should depend on a global the page may not have.
const SHOW_TEXT = 0x4

const isBlank = (text: string) => text.trim() === ''

/**
 * Ranges over the text drawn under `root`, one per changed span that is not
 * only whitespace. The spans are consecutive pieces of `root.textContent`, as
 * `wordDiff` returns them for it, so a range can start in one text node and
 * end in another -- across a bold word or a link.
 */
export function changedRanges(root: Node, spans: readonly LineSpan[]): Range[] {
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, SHOW_TEXT)
  const texts: { node: Node; start: number; end: number }[] = []
  let length = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const size = node.nodeValue?.length ?? 0
    texts.push({ node, start: length, end: length + size })
    length += size
  }
  // A range starts in the node holding its first character and ends in the
  // node holding its last, so it never begins or ends on an empty boundary.
  const startOf = (at: number) => texts.find((text) => at >= text.start && at < text.end)
  const endOf = (at: number) => texts.find((text) => at > text.start && at <= text.end)
  const ranges: Range[] = []
  let position = 0
  for (const span of spans) {
    const from = position
    position += span.text.length
    if (!span.changed || isBlank(span.text)) {
      continue
    }
    const first = startOf(from)
    const last = endOf(position)
    if (!first || !last) {
      continue
    }
    const range = doc.createRange()
    range.setStart(first.node, from - first.start)
    range.setEnd(last.node, position - last.start)
    ranges.push(range)
  }
  return ranges
}

const HIGHLIGHT = { removed: 'markdown-diff-removed', added: 'markdown-diff-added' } as const

// The changed words are painted through the CSS Custom Highlight API rather
// than wrapped in elements: the blocks are drawn by the caller's renderer and
// owned by React, and a wrapper inserted into that DOM is undone -- or breaks
// the next render -- the moment a code block finishes highlighting or a
// reference resolves. A highlight only names ranges; nothing in the tree moves.
const HIGHLIGHT_STYLE = `::highlight(${HIGHLIGHT.removed}){background-color:color-mix(in oklab,var(--color-destructive) 30%,transparent)}::highlight(${HIGHLIGHT.added}){background-color:color-mix(in oklab,var(--color-success) 30%,transparent)}`

function namedHighlight(registry: HighlightRegistry, name: string): Highlight {
  const existing = registry.get(name)
  if (existing) {
    return existing
  }
  const created = new Highlight()
  registry.set(name, created)
  return created
}

/**
 * Marks the words a changed block's two versions do not share, in each
 * version's own drawing, and again whenever either drawing changes (a code
 * block finishing its colours, a reference resolving). A version that differs
 * in all of its words is left to its frame's colour. Where the browser has no
 * highlight registry the frames still show what changed, block by block.
 */
function useChangedWords(removedRef: RefObject<HTMLModElement | null>, addedRef: RefObject<HTMLModElement | null>) {
  useEffect(() => {
    const removed = removedRef.current
    const added = addedRef.current
    const registry = typeof CSS === 'undefined' ? undefined : CSS.highlights
    if (!removed || !added || !registry) {
      return
    }
    let marked: [Highlight, Range][] = []
    const unmark = () => {
      for (const [highlight, range] of marked) {
        highlight.delete(range)
      }
      marked = []
    }
    const mark = () => {
      unmark()
      const words = wordDiff(removed.textContent ?? '', added.textContent ?? '', MAX_BLOCK_TEXT)
      if (!words) {
        return
      }
      const sides = [
        [HIGHLIGHT.removed, removed, words.removed],
        [HIGHLIGHT.added, added, words.added],
      ] as const
      for (const [name, frame, spans] of sides) {
        if (spans.every((span) => span.changed)) {
          continue
        }
        const highlight = namedHighlight(registry, name)
        for (const range of changedRanges(frame, spans)) {
          highlight.add(range)
          marked.push([highlight, range])
        }
      }
    }
    mark()
    const observer = new MutationObserver(mark)
    for (const frame of [removed, added]) {
      observer.observe(frame, { childList: true, characterData: true, subtree: true })
    }
    return () => {
      observer.disconnect()
      unmark()
    }
  }, [removedRef, addedRef])
}

/*
 * Where a block is drawn in parts, the parts' margins on the edges they share
 * are dropped: two items of a list stand as far apart as two items of one list
 * do, and two lines of a paragraph as two lines do, rather than as far as two
 * lists or two paragraphs.
 */
interface Joins {
  /** The part continues the one above it. */
  top?: boolean
  /** The part is continued by the one below it. */
  bottom?: boolean
}

const joinClasses = ({ top, bottom }: Joins) =>
  cn(top && '[&>:first-child]:mt-0', bottom && '[&>:last-child]:mb-0')

const FRAME: Record<'removed' | 'added', string> = {
  removed: 'bg-destructive/10 shadow-[inset_3px_0_0_var(--color-destructive)]',
  added: 'bg-success/10 shadow-[inset_3px_0_0_var(--color-success)]',
}

/*
 * A changed block in its frame: `del` or `ins`, which is what it is, drawn as a
 * tinted block with a bar at its start. The frame takes no vertical padding
 * and lets its content overflow, so the block's own margins meet its
 * neighbours' as they do on the page; the horizontal inset is given back with
 * a negative margin, so the text stays where the page puts it.
 */
function ChangedBlock({
  kind,
  frameRef,
  joins = {},
  children,
}: {
  kind: 'removed' | 'added'
  frameRef?: RefObject<HTMLModElement | null>
  joins?: Joins
  children: ReactNode
}) {
  const Frame = kind === 'removed' ? 'del' : 'ins'
  return (
    <Frame
      ref={frameRef}
      data-diff={kind}
      className={cn('-mx-3 block overflow-visible px-3 no-underline', FRAME[kind], joinClasses(joins))}
    >
      {children}
    </Frame>
  )
}

function ChangedPair({ removed, added, joins = {} }: { removed: ReactNode; added: ReactNode; joins?: Joins }) {
  const removedRef = useRef<HTMLModElement>(null)
  const addedRef = useRef<HTMLModElement>(null)
  useChangedWords(removedRef, addedRef)
  // The two versions of a part are parts of one block, so they join; two
  // versions of a whole block stand apart, as two blocks do.
  const between = joins.top !== undefined || joins.bottom !== undefined
  return (
    <>
      <ChangedBlock kind='removed' frameRef={removedRef} joins={{ top: joins.top, bottom: between }}>
        {removed}
      </ChangedBlock>
      <ChangedBlock kind='added' frameRef={addedRef} joins={{ top: between, bottom: joins.bottom }}>
        {added}
      </ChangedBlock>
    </>
  )
}

/*
 * A changed code block as the line diff of its code, in a box set where the
 * page sets a code block's.
 */
function ChangedCode({ removed, added }: { removed: string; added: string }) {
  const diff = useMemo(() => lineDiff(removed, added), [removed, added])
  return (
    <div
      data-diff='code'
      className='my-[var(--prose-pre-space,0.5em)] overflow-hidden rounded-[var(--prose-pre-radius,0.4rem)] border border-border bg-muted/40'
    >
      <DiffView diff={diff} />
    </div>
  )
}

interface Drawing {
  /** Draws markdown of the earlier version, a removed block or part. */
  earlier: (markdown: string) => ReactNode
  /** Draws markdown of the later version, an added or unchanged one. */
  later: (markdown: string) => ReactNode
}

// One changed or unchanged entry: a block, or a part of one when `joins` is given.
function DiffEntry({ item, drawing, joins }: { item: MarkdownDiffItem; drawing: Drawing; joins?: Joins }) {
  switch (item.kind) {
    case 'same':
      return joins ? <div className={joinClasses(joins)}>{drawing.later(item.block)}</div> : drawing.later(item.block)
    case 'removed':
    case 'added':
      return (
        <ChangedBlock kind={item.kind} joins={joins}>
          {item.kind === 'removed' ? drawing.earlier(item.block) : drawing.later(item.block)}
        </ChangedBlock>
      )
    case 'pair':
      return <ChangedPair removed={drawing.earlier(item.removed)} added={drawing.later(item.added)} joins={joins} />
    case 'code':
      return <ChangedCode removed={item.removed} added={item.added} />
    case 'parts':
      return <DiffParts parts={item.parts} drawing={drawing} />
    case 'nested':
      return (
        <>
          <div className={joinClasses({ top: joins?.top, bottom: true })}>{drawing.later(item.head)}</div>
          {/*
           * The nested list's parts sit in a list item of the view's own, with
           * no marker, so the page's list indent puts them where the page's
           * nested list is.
           */}
          <ul className='my-0 list-none'>
            <li className='my-0'>
              <DiffParts parts={item.parts} drawing={drawing} />
            </li>
          </ul>
        </>
      )
    case 'fold':
      return null
  }
}

function DiffParts({ parts, drawing }: { parts: MarkdownDiffItem[]; drawing: Drawing }) {
  return parts.map((part, index) => (
    <DiffEntry
      // Parts are derived from the two texts alone and never reordered, so a
      // part's position is its identity.
      // biome-ignore lint/suspicious/noArrayIndexKey: a part's position is its identity
      key={index}
      item={part}
      drawing={drawing}
      joins={{ top: index > 0, bottom: index < parts.length - 1 }}
    />
  ))
}

export interface MarkdownDiffViewProps {
  /** The earlier version's markdown. Empty for a document that did not exist. */
  before: string
  /** The later version's markdown. */
  after: string
  /**
   * Draws one block's markdown as your page draws markdown, WITHOUT a prose
   * wrapper of its own: the blocks are set side by side in this view's prose,
   * where their margins meet as they do on your page. It is also handed parts
   * of a block -- a list's items, a paragraph's lines -- each as markdown that
   * stands on its own.
   */
  renderBlock: (markdown: string) => ReactNode
  /** Unchanged blocks kept around each change before a run folds. Defaults to 1. */
  context?: number
  /** The prose the blocks are set in, replacing the default `prose-chat`. */
  proseClassName?: string
}

/**
 * The changes between two versions of a markdown document, on the document as
 * it renders. Blocks are compared by what they draw rather than how their
 * markdown is spelled, so one only rewrapped or re-escaped is unchanged. A
 * changed block is shown removed and added with the differing words marked in
 * its rendered text, narrowed to the items of a list and the lines of a
 * paragraph that changed, and a changed code block is a line diff of its code.
 */
export function MarkdownDiffView({ before, after, renderBlock, context, proseClassName = 'prose-chat' }: MarkdownDiffViewProps) {
  const earlier = useMemo(() => markdownBlocks(before), [before])
  const later = useMemo(() => markdownBlocks(after), [after])
  const items = useMemo(() => markdownDiff(earlier, later, context), [earlier, later, context])
  // The folds opened are those of one diff: an index means another fold once
  // the versions change, so a new diff starts with every fold closed.
  const [openedIn, setOpenedIn] = useState<{ items: MarkdownDiffItem[]; indices: ReadonlySet<number> }>({
    items,
    indices: new Set(),
  })
  const opened = openedIn.items === items ? openedIn.indices : new Set<number>()
  const setOpened = (indices: ReadonlySet<number>) => setOpenedIn({ items, indices })
  if (items.length === 0) {
    return <p className='text-sm text-muted-foreground'>No changes</p>
  }
  const drawing: Drawing = {
    earlier: (block) => renderBlock(withDefinitions(block, earlier.definitions)),
    later: (block) => renderBlock(withDefinitions(block, later.definitions)),
  }
  return (
    <div className={proseClassName}>
      <style href='markdown-diff-view' precedence='default'>
        {HIGHLIGHT_STYLE}
      </style>
      {items.map((item, index) => {
        // Items are derived from the two texts alone and never reordered, so
        // an item's position is its identity.
        if (item.kind !== 'fold') {
          // biome-ignore lint/suspicious/noArrayIndexKey: an item's position is its identity
          return <DiffEntry key={index} item={item} drawing={drawing} />
        }
        return opened.has(index) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: an item's position is its identity
          <Fragment key={index}>
            {item.blocks.map((block, offset) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a block's position is its identity
              <Fragment key={offset}>{drawing.later(block)}</Fragment>
            ))}
          </Fragment>
        ) : (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: an item's position is its identity
            key={index}
            type='button'
            onClick={() => setOpened(new Set(opened).add(index))}
            className='my-2 block w-full select-none rounded-sm py-1 text-left text-xs text-muted-foreground/80 hover:bg-muted/50 hover:text-muted-foreground'
          >
            ⋯ {item.blocks.length} unchanged blocks
          </button>
        )
      })}
    </div>
  )
}
