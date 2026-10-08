import { Fragment, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react'

import { CodeFrame } from 'agent-chat/components/code-block'
import { fenceLanguage } from 'agent-chat/components/code-highlight'
import { cn } from 'cn'

import { type ColourRun, type DiffLine, DiffView, type LineSpan, lineDiff, wordDiff } from '../tool-views/diff-view'
import { type MarkdownDiffItem, markdownBlocks, markdownDiff, withDefinitions } from './markdown-diff'

// The longest rendered text of a block that is compared word by word. The word
// search stops after a few dozen differing words whatever the length, so a long
// block costs little; past this a block is marked all through, as a rewrite.
const MAX_BLOCK_TEXT = 20_000

// NodeFilter.SHOW_TEXT, as a value: the walker is made from the frame's own
// document, and nothing here should depend on a global the page may not have.
const SHOW_TEXT = 0x4

const isBlank = (text: string) => text.trim() === ''

interface WordText {
  node: Node
  start: number
  end: number
  /** Texts in one run have no picture between them. */
  run: number
}

/*
 * The text nodes drawn under `root` as words, in order, with their offsets in
 * the text they make up. A picture's text -- an svg's labels and its styles --
 * is not words and is left out, wherever the picture sits; the texts either
 * side of a picture are in separate runs.
 */
function wordTexts(root: Node): WordText[] {
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, SHOW_TEXT)
  const texts: WordText[] = []
  let length = 0
  let run = 0
  let inPicture = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('svg')) {
      inPicture = true
      continue
    }
    if (inPicture) {
      run++
      inPicture = false
    }
    const size = node.nodeValue?.length ?? 0
    texts.push({ node, start: length, end: length + size, run })
    length += size
  }
  return texts
}

/** The text drawn under `root` as words: its text, less any picture's. */
export const wordText = (root: Node) =>
  wordTexts(root)
    .map((text) => text.node.nodeValue ?? '')
    .join('')

/**
 * Ranges over the text drawn under `root`, one per changed span that is not
 * only whitespace. The spans are consecutive pieces of `wordText(root)`, as
 * `wordDiff` returns them for it, so a range can start in one text node and
 * end in another -- across a bold word or a link -- but never reaches over a
 * picture: a span either side of one is a range on each side.
 */
export function changedRanges(root: Node, spans: readonly LineSpan[]): Range[] {
  const doc = root.ownerDocument ?? (root as Document)
  const texts = wordTexts(root)
  const ranges: Range[] = []
  let position = 0
  for (const span of spans) {
    const from = position
    position += span.text.length
    if (!span.changed || isBlank(span.text)) {
      continue
    }
    // The nodes holding the span's characters, never one it only touches, so
    // a range never begins or ends on an empty boundary.
    const held = texts.filter((text) => text.end > from && text.start < position)
    for (const run of new Set(held.map((text) => text.run))) {
      const inRun = held.filter((text) => text.run === run)
      const first = inRun[0]
      const last = inRun[inRun.length - 1]
      const range = doc.createRange()
      range.setStart(first.node, Math.max(from, first.start) - first.start)
      range.setEnd(last.node, Math.min(position, last.end) - last.start)
      if (!isBlank(range.toString())) {
        ranges.push(range)
      }
    }
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
 * in all of its words, or a pair too far apart or too long to compare, is
 * marked all through. A picture -- a diagram drawn as an svg -- is not words
 * and carries no marks; its frame shows it changed. Only where the browser has
 * no highlight registry is nothing marked; the frames still show what changed,
 * block by block.
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
      const before = wordText(removed)
      const after = wordText(added)
      const words = wordDiff(before, after, MAX_BLOCK_TEXT) ?? {
        removed: [{ text: before, changed: true }],
        added: [{ text: after, changed: true }],
      }
      const sides = [
        [HIGHLIGHT.removed, removed, words.removed],
        [HIGHLIGHT.added, added, words.added],
      ] as const
      for (const [name, frame, spans] of sides) {
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
 *
 * The margins left inside a part -- a loose item's paragraph, an item's own --
 * must still meet the next part's, as they do in one list. A prose may let its
 * children scroll (`overflow-x: auto`), which would keep each part's margins
 * inside it and add them up, so a part lets its content overflow.
 */
interface Joins {
  /** The part continues the one above it. */
  top?: boolean
  /** The part is continued by the one below it. */
  bottom?: boolean
}

const joinClasses = ({ top, bottom }: Joins) =>
  cn('overflow-visible', top && '[&>:first-child]:mt-0', bottom && '[&>:last-child]:mb-0')

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
      className={cn('-mx-3 block px-3 no-underline', FRAME[kind], joinClasses(joins))}
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

// A fence's info string as a changed fence's label names it.
const fenceName = (info: string) => info || 'no language'

/**
 * A highlighter's colours for a code block: runs over `code` in the language
 * its fence's `info` string names, in order and none reaching past a line's
 * end, or null when it has none for it.
 */
export type HighlightCode = (code: string, info: string) => Promise<readonly ColourRun[] | null>

// A code block's runs by line, each as offsets into its own line, in one
// pass: the runs come in order, so the line a run is on is the line the run
// before it was on or one after it.
export function runsByLine(code: string, runs: readonly ColourRun[]): ColourRun[][] {
  const lines = code.split('\n')
  const byLine: ColourRun[][] = lines.map(() => [])
  let line = 0
  let lineStart = 0
  for (const run of runs) {
    while (line < lines.length - 1 && run.start > lineStart + lines[line].length) {
      lineStart += lines[line].length + 1
      line++
    }
    byLine[line].push({ start: run.start - lineStart, end: run.end - lineStart, style: run.style })
  }
  return byLine
}

// One version's colours, with the code they were made for.
interface Colouring {
  code: string
  runs: readonly ColourRun[]
}

/**
 * `code`'s colours by line from a colouring of it, or of the text it was
 * before an edit: a line that text also has keeps that line's colours, so an
 * edit leaves the lines it did not touch coloured until their new colours
 * arrive.
 */
function coloursByLine(code: string, colouring: Colouring): readonly (readonly ColourRun[])[] {
  const lines = runsByLine(colouring.code, colouring.runs)
  if (code === colouring.code) {
    return lines
  }
  const byText = new Map<string, readonly ColourRun[]>()
  colouring.code.split('\n').forEach((text, index) => {
    if (!byText.has(text)) {
      byText.set(text, lines[index])
    }
  })
  return code.split('\n').map((text) => byText.get(text) ?? [])
}

// Each line of a code diff with its colours: a removed line in the earlier
// version's language, an added or unchanged one in the later version's.
function lineColours(
  diff: readonly DiffLine[],
  removed: readonly (readonly ColourRun[])[],
  added: readonly (readonly ColourRun[])[],
): Map<DiffLine, readonly ColourRun[]> {
  const colours = new Map<DiffLine, readonly ColourRun[]>()
  let earlier = 0
  let later = 0
  for (const line of diff) {
    const runs = line.kind === 'removed' ? removed[earlier] : added[later]
    if (runs?.length) {
      colours.set(line, runs)
    }
    if (line.kind !== 'added') {
      earlier++
    }
    if (line.kind !== 'removed') {
      later++
    }
  }
  return colours
}

/*
 * A changed code block as the line diff of its code, in the frame the page
 * sets a code block in and lettered as its code is, headed by its language,
 * or by the change of its fence's language or meta when that changed. Code
 * that did not change under a changed fence is shown as its lines.
 */
function ChangedCode({
  removed,
  added,
  fence,
  highlightCode,
}: Extract<MarkdownDiffItem, { kind: 'code' }> & { highlightCode?: HighlightCode }) {
  const diff = useMemo(() => lineDiff(removed, added), [removed, added])
  const [colouring, setColouring] = useState<{ removed: Colouring; added: Colouring } | null>(null)
  // Text first, colour second, as the page's own code blocks do: the lines
  // show at once and gain their colours when the highlighter has them. Until
  // an edit's colours arrive, the colouring before it stands.
  useEffect(() => {
    if (!highlightCode) {
      return
    }
    let live = true
    Promise.all([highlightCode(removed, fence.removed), highlightCode(added, fence.added)])
      .then(([earlier, later]) => {
        if (live) {
          setColouring({ removed: { code: removed, runs: earlier ?? [] }, added: { code: added, runs: later ?? [] } })
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [highlightCode, removed, added, fence.removed, fence.added])
  const colours = useMemo(
    () =>
      highlightCode && colouring
        ? lineColours(diff, coloursByLine(removed, colouring.removed), coloursByLine(added, colouring.added))
        : undefined,
    [highlightCode, diff, colouring, removed, added],
  )
  return (
    <CodeFrame
      data-diff='code'
      // Labelled as a code block is, with its language or nothing; a changed
      // fence is labelled with the change, meta included.
      label={
        fence.removed === fence.added ? (
          fenceLanguage(fence.added)
        ) : (
          <span data-diff='fence' className='contents'>
            <del className='text-destructive'>{fenceName(fence.removed)}</del>
            <span aria-hidden='true'>→</span>
            <ins className='text-success no-underline'>{fenceName(fence.added)}</ins>
          </span>
        )
      }
    >
      <DiffView diff={diff} variant='code' colours={colours} />
    </CodeFrame>
  )
}

interface Drawing {
  /** Draws markdown of the earlier version, a removed block or part. */
  earlier: (markdown: string) => ReactNode
  /** Draws markdown of the later version, an added or unchanged one. */
  later: (markdown: string) => ReactNode
  /** Colours a changed code block's lines, where the caller has a highlighter. */
  highlightCode?: HighlightCode
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
      return <ChangedCode {...item} highlightCode={drawing.highlightCode} />
    case 'parts':
      if (item.of === 'lines') {
        return <DiffParts parts={item.parts} drawing={drawing} />
      }
      /*
       * A list's parts sit in one block that stands where the page's list
       * does: a child of the prose, so it holds its items' outer margins in
       * as the list does where the prose lets its children scroll, with the
       * list's own margins around it. Its inset makes room for the frames'
       * bleed, which would otherwise scroll.
       */
      return (
        <div className='-mx-3 my-[var(--prose-list-space)] px-3'>
          <DiffParts parts={item.parts} drawing={drawing} joins={{ top: true, bottom: true }} />
        </div>
      )
    case 'nested':
      return (
        <>
          <div className={joinClasses({ top: joins?.top, bottom: true })}>{drawing.later(item.head)}</div>
          {/*
           * The nested list's parts sit in a list item of the view's own, with
           * no marker, so the page's list indent puts them where the page's
           * nested list is. Each part is drawn as a list of its own, which
           * the prose spaces as a top-level list; the parts drop that margin
           * where they continue the item above, and this list stands as far
           * from it as the page's nested list does.
           */}
          <ul className='my-[var(--prose-nested-list-space)] list-none overflow-visible'>
            <li className='my-0'>
              <DiffParts parts={item.parts} drawing={drawing} joins={{ top: true, bottom: joins?.bottom }} />
            </li>
          </ul>
        </>
      )
    case 'fold':
      return null
  }
}

// `joins` are the edges of the whole run: a run of nested parts continues the item above it.
function DiffParts({ parts, drawing, joins = {} }: { parts: MarkdownDiffItem[]; drawing: Drawing; joins?: Joins }) {
  return parts.map((part, index) => (
    <DiffEntry
      // Parts are derived from the two texts alone and never reordered, so a
      // part's position is its identity.
      // biome-ignore lint/suspicious/noArrayIndexKey: a part's position is its identity
      key={index}
      item={part}
      drawing={drawing}
      joins={{ top: index > 0 || Boolean(joins.top), bottom: index < parts.length - 1 || Boolean(joins.bottom) }}
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
   * stands on its own. Items of a loose list end with a link definition, which
   * draws nothing and keeps them loose.
   */
  renderBlock: (markdown: string) => ReactNode
  /** Unchanged blocks kept around each change before a run folds. Defaults to 1. */
  context?: number
  /** The prose the blocks are set in, replacing the default `prose-chat`. */
  proseClassName?: string
  /**
   * Colours the lines of a changed code block, as your page's code blocks are
   * coloured: removed lines in the earlier fence's language, added and
   * unchanged ones in the later's. Without it the lines are plain.
   */
  highlightCode?: HighlightCode
}

/**
 * The changes between two versions of a markdown document, on the document as
 * it renders. Blocks are compared by what they draw rather than how their
 * markdown is spelled, so one only rewrapped or re-escaped is unchanged. A
 * changed block is shown removed and added with the differing words marked in
 * its rendered text, narrowed to the items of a list and the lines of a
 * paragraph that changed, and a changed code block is a line diff of its code.
 */
export function MarkdownDiffView({
  before,
  after,
  renderBlock,
  context,
  proseClassName = 'prose-chat',
  highlightCode,
}: MarkdownDiffViewProps) {
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
    highlightCode,
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
