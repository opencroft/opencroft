import { useMemo, useState } from 'react'

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

// Below this share of their visible characters in common, two lines are
// treated as rewritten: marking the few characters they happen to share would
// suggest an edit that was not made, so all of each line is marked instead.
const MIN_SHARED_SHARE = 0.5

// Words, runs of whitespace, and each other character on its own.
const WORD = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu

const isBlank = (text: string) => text.trim() === ''

const visibleLength = (texts: readonly string[]) =>
  texts.reduce((sum, text) => sum + text.replace(/\s+/g, '').length, 0)

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
// as spans of each: the differing words, or all of each line when the two are
// too different for a partial mark to be true. Null when either is longer than
// `maxLength` characters.
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
  const shared = visibleLength(words.filter((word) => word.kind === 'same').map((word) => word.text))
  const total = visibleLength(a) + visibleLength(b)
  if (total === 0 || (2 * shared) / total < MIN_SHARED_SHARE) {
    return whole
  }
  return {
    removed: sideSpans(words.filter((word) => word.kind !== 'added')),
    added: sideSpans(words.filter((word) => word.kind !== 'removed')),
  }
}

// The changed spans of every changed line that has them. Within each run of
// changed lines, the removed lines are paired in order with the added ones,
// the n-th with the n-th; a line left over, or one too long to compare, has
// none and keeps only the line's colour.
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
      const words = wordDiff(removed[pair].text, added[pair].text)
      if (words) {
        spans.set(removed[pair], words.removed)
        spans.set(added[pair], words.added)
      }
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
  added: 'rounded-sm bg-success/30',
  removed: 'rounded-sm bg-destructive/30',
}

function DiffLineRow({ line: entry, spans }: { line: DiffLine; spans?: readonly LineSpan[] }) {
  return (
    <div className={cn('flex min-w-0', LINE_TONE[entry.kind])}>
      <span aria-hidden className={cn('w-4 shrink-0 select-none text-center', SIGN_TONE[entry.kind])}>
        {SIGN[entry.kind]}
      </span>
      <span className='sr-only'>{entry.kind === 'same' ? '' : `${entry.kind}: `}</span>
      {/* An empty line still takes a row, so a removed blank line is visible. */}
      <span className='min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere pr-2'>
        {spans?.length
          ? spans.map((span, index) => (
              // Spans are derived from the line alone and never reordered.
              // biome-ignore lint/suspicious/noArrayIndexKey: a span's position is its identity
              <span key={index} className={span.changed ? SPAN_TONE[entry.kind] : undefined}>
                {span.text}
              </span>
            ))
          : entry.text || ' '}
      </span>
    </div>
  )
}

// One line-level diff renderer for every edit-shaped call. Long lines wrap
// rather than scroll, so it reads the same at phone width as on a desktop;
// unchanged runs fold into a row that opens them in place; within a replaced
// line, what differs from the line it replaced is marked.
export function DiffView({ diff, context = CONTEXT_LINES }: { diff: readonly DiffLine[]; context?: number }) {
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  const spans = useMemo(() => changedSpans(diff), [diff])
  const { added, removed } = diffStats(diff)
  if (added === 0 && removed === 0) {
    return <div className='px-3 py-2 text-xs text-muted-foreground'>No changes</div>
  }
  const rows = foldUnchanged(diff, context)
  return (
    <div className='min-w-0 py-1 font-mono text-[11px] leading-4'>
      {rows.map((row, index) =>
        row.kind === 'line' ? (
          // Rows are derived from the diff alone and never reordered, so a
          // row's position is its identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
          <DiffLineRow key={index} line={row.line} spans={spans.get(row.line)} />
        ) : opened.has(index) ? (
          row.lines.map((entry, offset) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
            <DiffLineRow key={`${index}.${offset}`} line={entry} />
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
