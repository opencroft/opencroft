import { useState } from 'react'

import { cn } from 'cn'

// A line-level diff: which lines two texts share, which the first has that the
// second does not (removed) and the reverse (added), in reading order.
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

// Myers' O((N+M)D) shortest edit script. Each round's frontier is kept only
// over the diagonals that round can reach, so memory grows with D² rather than
// with D·(N+M).
function shortestEdit(a: string[], b: string[]): DiffLine[] | null {
  const n = a.length
  const m = b.length
  const offset = n + m + 1
  const frontier = new Int32Array(2 * offset + 1)
  const rounds: Int32Array[] = []
  const pick = (v: (k: number) => number, k: number, d: number) =>
    k === -d || (k !== d && v(k - 1) < v(k + 1)) ? k + 1 : k - 1

  search: for (let d = 0; ; d++) {
    if (d > MAX_EDITS) {
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

// The line diff from `original` to `value`. Lines both texts start and end with
// are matched before the search, so an edit to a long text costs what the
// changed region costs.
export function lineDiff(original: string, value: string): DiffLine[] {
  const a = splitLines(original)
  const b = splitLines(value)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const middleA = a.slice(start, endA)
  const middleB = b.slice(start, endB)
  const middle = shortestEdit(middleA, middleB) ?? [
    ...middleA.map(line('removed')),
    ...middleB.map(line('added')),
  ]
  return [...a.slice(0, start).map(line('same')), ...middle, ...a.slice(endA).map(line('same'))]
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
// and each longer unchanged run folded into one row that holds its lines.
export type DiffRow = { kind: 'line'; line: DiffLine } | { kind: 'fold'; lines: DiffLine[] }

export function foldUnchanged(diff: readonly DiffLine[], context = CONTEXT_LINES): DiffRow[] {
  const rows: DiffRow[] = []
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

function DiffLineRow({ line: entry }: { line: DiffLine }) {
  return (
    <div className={cn('flex min-w-0', LINE_TONE[entry.kind])}>
      <span aria-hidden className={cn('w-4 shrink-0 select-none text-center', SIGN_TONE[entry.kind])}>
        {SIGN[entry.kind]}
      </span>
      <span className='sr-only'>{entry.kind === 'same' ? '' : `${entry.kind}: `}</span>
      {/* An empty line still takes a row, so a removed blank line is visible. */}
      <span className='min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere pr-2'>{entry.text || ' '}</span>
    </div>
  )
}

// One line-level diff renderer for every edit-shaped call. Long lines wrap
// rather than scroll, so it reads the same at phone width as on a desktop;
// unchanged runs fold into a row that opens them in place.
export function DiffView({ diff, context = CONTEXT_LINES }: { diff: readonly DiffLine[]; context?: number }) {
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
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
          <DiffLineRow key={index} line={row.line} />
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
