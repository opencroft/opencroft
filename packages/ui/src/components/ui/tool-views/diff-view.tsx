import { type CSSProperties, useMemo, useState } from 'react'

import { cn } from 'cn'

// A line-level diff: which lines two texts share, which the first has that the
// second does not (removed) and the reverse (added), in reading order. The
// same shape serves any sequence `sequenceDiff` compares, an item per entry.
export interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
}

// Unchanged lines kept around each change before the rest of an unchanged run
// is folded away.
const CONTEXT_LINES = 3

// Past this many added-plus-removed lines the texts are treated as unrelated:
// everything of the first is shown removed and everything of the second added.
// The search costs time proportional to the edit count and memory to its
// square, and a diff that large reads no better than the two texts themselves.
const MAX_EDITS = 1000

// A final newline ends the last line rather than starting an empty one, so
// "a\n" and "a" are the same one line.
function splitLines(text: string): string[] {
  if (text === '') {
    return []
  }
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

const line = (kind: DiffLine['kind']) => (text: string) => ({ kind, text })

// Myers' O((N+M)D) shortest edit script, or null when it needs more than
// `maxEdits` edits. Each round's frontier is kept only over the diagonals that
// round can reach, so memory grows with D² rather than with D·(N+M).
function shortestEdit(a: readonly string[], b: readonly string[], maxEdits: number): DiffLine[] | null {
  const n = a.length
  const m = b.length
  const offset = n + m + 1
  const frontier = new Int32Array(2 * offset + 1)
  const rounds: Int32Array[] = []
  const pick = (v: (k: number) => number, k: number, d: number) =>
    k === -d || (k !== d && v(k - 1) < v(k + 1)) ? k + 1 : k - 1

  search: for (let d = 0; ; d++) {
    if (d > maxEdits) {
      return null
    }
    rounds.push(frontier.slice(offset - d, offset + d + 1))
    for (let k = -d; k <= d; k += 2) {
      const from = pick((i) => frontier[offset + i], k, d)
      let x = from === k + 1 ? frontier[offset + from] : frontier[offset + from] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      frontier[offset + k] = x
      if (x >= n && y >= m) {
        break search
      }
    }
  }

  const out: DiffLine[] = []
  let x = n
  let y = m
  for (let d = rounds.length - 1; d >= 0; d--) {
    const round = rounds[d]
    const k = x - y
    const from = pick((i) => round[i + d], k, d)
    const fromX = round[from + d] ?? 0
    const fromY = fromX - from
    while (x > fromX && y > fromY) {
      out.push({ kind: 'same', text: a[--x] })
      y--
    }
    if (d > 0) {
      if (x === fromX) {
        out.push({ kind: 'added', text: b[--y] })
      } else {
        out.push({ kind: 'removed', text: a[--x] })
      }
    }
  }
  return out.reverse()
}

// How many items `a` and `b` share at their start, and how many after that at
// their end. Matching these before a search makes an edit to a long sequence
// cost what the changed region costs.
function sharedEnds(a: readonly string[], b: readonly string[]): { head: number; tail: number } {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++
  }
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++
  }
  return { head, tail }
}

// The diff from one sequence of items to another, each item compared whole.
export function sequenceDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const { head, tail } = sharedEnds(a, b)
  const middleA = a.slice(head, a.length - tail)
  const middleB = b.slice(head, b.length - tail)
  // With one side empty, as for a new file, the other is all change and there
  // is nothing to search.
  const searched = middleA.length > 0 && middleB.length > 0 ? shortestEdit(middleA, middleB, MAX_EDITS) : null
  const middle = searched ?? [...middleA.map(line('removed')), ...middleB.map(line('added'))]
  return [...a.slice(0, head).map(line('same')), ...middle, ...a.slice(a.length - tail).map(line('same'))]
}

// The line diff from `original` to `value`.
export function lineDiff(original: string, value: string): DiffLine[] {
  return sequenceDiff(splitLines(original), splitLines(value))
}

// A stretch of a changed line's text, `changed` when it is what differs from
// the line it was paired with.
export interface LineSpan {
  text: string
  changed: boolean
}

// Lines longer than this are not compared word by word and are left unmarked:
// a long line costs the most to search and reads worst marked up.
const MAX_SPAN_LINE_LENGTH = 400

// Past this many differing words the two lines are treated as rewritten, and
// the search stops there.
const MAX_WORD_EDITS = 50

// Words, runs of whitespace, and each other character on its own.
const WORD = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu

const isBlank = (text: string) => text.trim() === ''

// One side of a word diff as spans: adjacent words of the same kind joined, and
// whitespace between two changed words marked with them, so a changed phrase
// reads as one stretch.
function sideSpans(words: readonly DiffLine[]): LineSpan[] {
  const spans: LineSpan[] = []
  words.forEach((word, index) => {
    const betweenChanges =
      index > 0 && index < words.length - 1 && words[index - 1].kind !== 'same' && words[index + 1].kind !== 'same'
    const changed = word.kind !== 'same' || (isBlank(word.text) && betweenChanges)
    const last = spans[spans.length - 1]
    if (last && last.changed === changed) {
      last.text += word.text
    } else {
      spans.push({ text: word.text, changed })
    }
  })
  return spans
}

// A rewritten line as spans: all of it changed. An empty line has nothing to
// mark.
const rewritten = (text: string): LineSpan[] => (text === '' ? [] : [{ text, changed: true }])

// What differs between a removed line and the added line that replaced it,
// as spans of each: the differing words, however few the two share, or all of
// each line when they differ in more words than are worth searching. Null when
// either is longer than `maxLength` characters.
export function wordDiff(
  removed: string,
  added: string,
  maxLength = MAX_SPAN_LINE_LENGTH,
): { removed: LineSpan[]; added: LineSpan[] } | null {
  if (removed.length > maxLength || added.length > maxLength) {
    return null
  }
  const whole = { removed: rewritten(removed), added: rewritten(added) }
  const a = removed.match(WORD) ?? []
  const b = added.match(WORD) ?? []
  const { head, tail } = sharedEnds(a, b)
  const middle = shortestEdit(a.slice(head, a.length - tail), b.slice(head, b.length - tail), MAX_WORD_EDITS)
  if (!middle) {
    return whole
  }
  const words = [...a.slice(0, head).map(line('same')), ...middle, ...a.slice(a.length - tail).map(line('same'))]
  return {
    removed: sideSpans(words.filter((word) => word.kind !== 'added')),
    added: sideSpans(words.filter((word) => word.kind !== 'removed')),
  }
}

// The changed spans of every changed line that has them. Within each run of
// changed lines, the removed lines are paired in order with the added ones,
// the n-th with the n-th, and a pair too long to compare is marked whole, as a
// rewrite. A line left over has no pair and keeps only the line's colour.
export function changedSpans(diff: readonly DiffLine[]): Map<DiffLine, LineSpan[]> {
  const spans = new Map<DiffLine, LineSpan[]>()
  let i = 0
  while (i < diff.length) {
    if (diff[i].kind === 'same') {
      i++
      continue
    }
    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    for (; i < diff.length && diff[i].kind !== 'same'; i++) {
      if (diff[i].kind === 'removed') {
        removed.push(diff[i])
      } else {
        added.push(diff[i])
      }
    }
    for (let pair = 0; pair < Math.min(removed.length, added.length); pair++) {
      const words = wordDiff(removed[pair].text, added[pair].text) ?? {
        removed: rewritten(removed[pair].text),
        added: rewritten(added[pair].text),
      }
      spans.set(removed[pair], words.removed)
      spans.set(added[pair], words.added)
    }
  }
  return spans
}

export function diffStats(diff: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const entry of diff) {
    if (entry.kind === 'added') {
      added++
    } else if (entry.kind === 'removed') {
      removed++
    }
  }
  return { added, removed }
}

// A diff as it is drawn: changed lines with a few unchanged ones around them,
// and each longer unchanged run folded into one row that holds its lines. The
// rows hold the diff's own entries, so an entry that carries more than a line
// comes back whole.
export type DiffRow<Line extends DiffLine = DiffLine> = { kind: 'line'; line: Line } | { kind: 'fold'; lines: Line[] }

export function foldUnchanged<Line extends DiffLine>(diff: readonly Line[], context = CONTEXT_LINES): DiffRow<Line>[] {
  const rows: DiffRow<Line>[] = []
  let i = 0
  while (i < diff.length) {
    if (diff[i].kind !== 'same') {
      rows.push({ kind: 'line', line: diff[i++] })
      continue
    }
    let end = i
    while (end < diff.length && diff[end].kind === 'same') {
      end++
    }
    const keepBefore = i === 0 ? 0 : context
    const keepAfter = end === diff.length ? 0 : context
    const run = diff.slice(i, end)
    // Folding a single line would replace it with a row of the same height.
    if (run.length - keepBefore - keepAfter > 1) {
      rows.push(...run.slice(0, keepBefore).map((entry) => ({ kind: 'line' as const, line: entry })))
      rows.push({ kind: 'fold', lines: run.slice(keepBefore, run.length - keepAfter) })
      rows.push(...run.slice(run.length - keepAfter).map((entry) => ({ kind: 'line' as const, line: entry })))
    } else {
      rows.push(...run.map((entry) => ({ kind: 'line' as const, line: entry })))
    }
    i = end
  }
  return rows
}

// How many rows the diff takes once folded — what a caller compares with the
// room it has.
export function diffRowCount(diff: readonly DiffLine[]): number {
  return foldUnchanged(diff).length
}

const SIGN: Record<DiffLine['kind'], string> = { same: ' ', added: '+', removed: '−' }

const LINE_TONE: Record<DiffLine['kind'], string> = {
  same: 'text-muted-foreground',
  added: 'bg-success/10 text-foreground',
  removed: 'bg-destructive/10 text-foreground',
}

const SIGN_TONE: Record<DiffLine['kind'], string> = {
  same: '',
  added: 'text-success',
  removed: 'text-destructive',
}

// A changed span is the line's own tint again, stronger, over the line's.
const SPAN_TONE: Record<DiffLine['kind'], string> = {
  same: '',
  added: 'bg-success/30',
  removed: 'bg-destructive/30',
}

/**
 * A coloured run of a line's code, as offsets into the line's text. `style`
 * holds the run's colours as CSS declarations -- a syntax highlighter's
 * custom properties, `--shiki-light:#24292f;--shiki-dark:#9cdcfe` -- and the
 * run's text carries the `shiki-token` class, so the host's stylesheet picks
 * the colour for its theme exactly as it does for its own code blocks.
 */
export interface ColourRun {
  start: number
  end: number
  style: string
}

// A run's declarations as a React style object; custom properties keep their
// names as written.
function styleOf(declarations: string): CSSProperties {
  const style: Record<string, string> = {}
  for (const declaration of declarations.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon > 0) {
      style[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim()
    }
  }
  return style as CSSProperties
}

interface Piece {
  text: string
  changed: boolean
  style?: string
}

// A line's text in pieces that each keep one word mark and one colour: the
// word marks over the colours, as a reader sees a highlighted line marked.
export function linePieces(text: string, spans: readonly LineSpan[] = [], colours: readonly ColourRun[] = []): Piece[] {
  const edges = new Set([0, text.length])
  let at = 0
  for (const span of spans) {
    edges.add(at)
    at += span.text.length
    edges.add(at)
  }
  for (const run of colours) {
    edges.add(Math.max(0, Math.min(text.length, run.start)))
    edges.add(Math.max(0, Math.min(text.length, run.end)))
  }
  const sorted = [...edges].sort((a, b) => a - b)
  const pieces: Piece[] = []
  // The spans and the runs both go along the line in order, so one cursor
  // into each keeps up with the pieces.
  let span = 0
  let spanEnd = spans[0]?.text.length ?? 0
  let run = 0
  for (let index = 0; index < sorted.length - 1; index++) {
    const [from, to] = [sorted[index], sorted[index + 1]]
    if (from === to) {
      continue
    }
    while (span < spans.length && from >= spanEnd) {
      span++
      spanEnd += spans[span]?.text.length ?? 0
    }
    while (run < colours.length && colours[run].end <= from) {
      run++
    }
    const changed = span < spans.length && spans[span].changed
    const style = run < colours.length && colours[run].start <= from ? colours[run].style : undefined
    const last = pieces[pieces.length - 1]
    if (last && last.changed === changed && last.style === style) {
      last.text += text.slice(from, to)
    } else {
      pieces.push({ text: text.slice(from, to), changed, style })
    }
  }
  return pieces
}

function DiffLineRow({
  line: entry,
  spans,
  colours,
}: {
  line: DiffLine
  spans?: readonly LineSpan[]
  colours?: readonly ColourRun[]
}) {
  return (
    <div className={cn('flex min-w-0', LINE_TONE[entry.kind])}>
      <span aria-hidden className={cn('w-4 shrink-0 select-none text-center', SIGN_TONE[entry.kind])}>
        {SIGN[entry.kind]}
      </span>
      <span className='sr-only'>{entry.kind === 'same' ? '' : `${entry.kind}: `}</span>
      {/* An empty line still takes a row, so a removed blank line is visible. */}
      <span className='min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere pr-2'>
        {spans?.length || colours?.length
          ? linePieces(entry.text, spans, colours).map((piece, index) => (
              // Pieces are derived from the line alone and never reordered.
              // biome-ignore lint/suspicious/noArrayIndexKey: a piece's position is its identity
              <span
                key={index}
                className={cn(piece.changed && SPAN_TONE[entry.kind], piece.style && 'shiki-token')}
                style={piece.style ? styleOf(piece.style) : undefined}
              >
                {piece.text}
              </span>
            ))
          : entry.text || ' '}
      </span>
    </div>
  )
}

export interface DiffViewProps {
  diff: readonly DiffLine[]
  /** Unchanged lines kept around each change before a run folds. */
  context?: number
  /**
   * `compact`, the default, is the small type of a tool call's diff. `code`
   * sets the lines as the prose around it sets a code block -- its font size
   * and line height, from `--prose-pre-code-size` and
   * `--prose-pre-code-line-height` -- and shows a diff with no changes as its
   * lines rather than saying so.
   */
  variant?: 'compact' | 'code'
  /**
   * Each line's colours, for a diff of code a highlighter has coloured: runs
   * in order along the line, none overlapping another.
   */
  colours?: ReadonlyMap<DiffLine, readonly ColourRun[]>
}

const VARIANT_TYPE: Record<NonNullable<DiffViewProps['variant']>, string> = {
  compact: 'text-[11px] leading-4',
  // A code block is set at 0.85em of the prose, and its code at the scale's
  // own share of that: one size for the whole diff, which its rows inherit.
  code: 'text-[length:calc(0.85*var(--prose-pre-code-size,1em))] leading-[var(--prose-pre-code-line-height,1.5)]',
}

// One line-level diff renderer for every edit-shaped call. Long lines wrap
// rather than scroll, so it reads the same at phone width as on a desktop;
// unchanged runs fold into a row that opens them in place; within a replaced
// line, what differs from the line it replaced is marked.
export function DiffView({ diff, context = CONTEXT_LINES, variant = 'compact', colours }: DiffViewProps) {
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  const spans = useMemo(() => changedSpans(diff), [diff])
  const { added, removed } = diffStats(diff)
  const unchanged = added === 0 && removed === 0
  if (unchanged && variant === 'compact') {
    return <div className='px-3 py-2 text-xs text-muted-foreground'>No changes</div>
  }
  // Code with no changes is still shown, every line of it.
  const rows: DiffRow[] = unchanged ? diff.map((line) => ({ kind: 'line', line })) : foldUnchanged(diff, context)
  return (
    <div className={cn('min-w-0 py-1 font-mono', VARIANT_TYPE[variant])}>
      {rows.map((row, index) =>
        row.kind === 'line' ? (
          // Rows are derived from the diff alone and never reordered, so a
          // row's position is its identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
          <DiffLineRow key={index} line={row.line} spans={spans.get(row.line)} colours={colours?.get(row.line)} />
        ) : opened.has(index) ? (
          row.lines.map((entry, offset) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
            <DiffLineRow key={`${index}.${offset}`} line={entry} colours={colours?.get(entry)} />
          ))
        ) : (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
            key={index}
            type='button'
            onClick={() => setOpened(new Set(opened).add(index))}
            className='block w-full select-none px-4 text-left text-muted-foreground/80 hover:bg-muted/50 hover:text-muted-foreground'
          >
            ⋯ {row.lines.length} unchanged lines
          </button>
        ),
      )}
    </div>
  )
}

// The size of a diff as a header shows it: "+3 −1".
export function DiffStat({ diff }: { diff: readonly DiffLine[] }) {
  const { added, removed } = diffStats(diff)
  return (
    <span className='shrink-0 font-mono text-[10px] tabular-nums'>
      <span className='text-success'>+{added}</span> <span className='text-destructive'>−{removed}</span>
    </span>
  )
}
