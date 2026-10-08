import assert from 'node:assert/strict'
import test from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  changedSpans,
  type DiffLine,
  DiffView,
  diffStats,
  foldUnchanged,
  type LineSpan,
  lineDiff,
  linePieces,
  wordDiff,
} from './diff-view'

// Both sides a diff was taken between, read back out of it.
function sides(diff: DiffLine[]): { original: string[]; value: string[] } {
  return {
    original: diff.filter((entry) => entry.kind !== 'added').map((entry) => entry.text),
    value: diff.filter((entry) => entry.kind !== 'removed').map((entry) => entry.text),
  }
}

const lines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// Deterministic pseudo-random texts over a small alphabet, so lines repeat and
// the search has real choices to make.
function texts(seed: number, count: number): string[] {
  let state = seed
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state
  }
  return Array.from({ length: count }, () =>
    Array.from({ length: next() % 12 }, () => 'abcd'[next() % 4]).join('\n'),
  )
}

test('a diff holds both texts, line for line and in order', () => {
  const pool = texts(7, 40)
  for (const original of pool) {
    for (const value of pool.slice(0, 10)) {
      const diff = lineDiff(original, value)
      assert.deepEqual(sides(diff), { original: lines(original), value: lines(value) }, `${original} → ${value}`)
    }
  }
})

test('a one-line change in a long text is one removed and one added line', () => {
  const before = Array.from({ length: 200 }, (_, i) => `line ${i}`)
  const after = [...before]
  after[120] = 'line 120, changed'
  const diff = lineDiff(before.join('\n'), after.join('\n'))
  assert.deepEqual(diffStats(diff), { added: 1, removed: 1 })
  assert.deepEqual(
    diff.filter((entry) => entry.kind !== 'same'),
    [
      { kind: 'removed', text: 'line 120' },
      { kind: 'added', text: 'line 120, changed' },
    ],
  )
})

test('the diff is a shortest one: an insertion between shared lines touches nothing else', () => {
  const diff = lineDiff('a\nb\nc\na\nb', 'a\nb\nx\nc\na\nb')
  assert.deepEqual(diffStats(diff), { added: 1, removed: 0 })
})

test('empty sides: everything is added, or everything removed', () => {
  assert.deepEqual(lineDiff('', 'one\ntwo'), [
    { kind: 'added', text: 'one' },
    { kind: 'added', text: 'two' },
  ])
  assert.deepEqual(lineDiff('one\n', ''), [{ kind: 'removed', text: 'one' }])
  assert.deepEqual(lineDiff('', ''), [])
})

test('texts too different to search are shown as all removed, then all added', () => {
  const original = Array.from({ length: 700 }, (_, i) => `old ${i}`).join('\n')
  const value = Array.from({ length: 700 }, (_, i) => `new ${i}`).join('\n')
  const diff = lineDiff(original, value)
  assert.deepEqual(diffStats(diff), { added: 700, removed: 700 })
  assert.equal(diff[0].kind, 'removed')
  assert.equal(diff[700].kind, 'added')
})

test('long unchanged runs fold, keeping three lines of context beside each change', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`)
  const after = [...before]
  after[15] = 'changed'
  const rows = foldUnchanged(lineDiff(before.join('\n'), after.join('\n')))
  const shape = rows.map((row) => (row.kind === 'fold' ? `fold ${row.lines.length}` : row.line.kind))
  assert.deepEqual(shape, [
    'fold 12',
    'same',
    'same',
    'same',
    'removed',
    'added',
    'same',
    'same',
    'same',
    'fold 11',
  ])
  const unfolded = rows.flatMap((row) => (row.kind === 'fold' ? row.lines : [row.line]))
  assert.equal(unfolded.length, 31, 'folding hides lines, it does not drop them')
})

test('a run one line longer than its context is shown rather than folded to one line', () => {
  const rows = foldUnchanged(lineDiff('x\na\nb\nc\nd', 'y\na\nb\nc\nd'))
  assert.equal(
    rows.some((row) => row.kind === 'fold'),
    false,
  )
})

// The changed stretches of a span list, in order.
const marked = (spans: LineSpan[] | undefined) => spans?.filter((span) => span.changed).map((span) => span.text)

test('a one-word edit marks just that word, on the removed and on the added line', () => {
  const diff = lineDiff('const greeting = "hello world"\n', 'const greeting = "hello there"\n')
  const spans = changedSpans(diff)
  assert.deepEqual(spans.get(diff[0]), [
    { text: 'const greeting = "hello ', changed: false },
    { text: 'world', changed: true },
    { text: '"', changed: false },
  ])
  assert.deepEqual(spans.get(diff[1]), [
    { text: 'const greeting = "hello ', changed: false },
    { text: 'there', changed: true },
    { text: '"', changed: false },
  ])
})

test('the spans of each side join back into its line', () => {
  const pool = ['retries: 3,', 'retries: 5, // more', 'a.b(c, d)', 'a.b(c, e, f)', '  x = y + z', 'x = y - z;']
  for (const removed of pool) {
    for (const added of pool) {
      const words = wordDiff(removed, added)
      if (words) {
        assert.equal(words.removed.map((span) => span.text).join(''), removed, `${removed} → ${added}`)
        assert.equal(words.added.map((span) => span.text).join(''), added, `${removed} → ${added}`)
      }
    }
  }
})

test('a changed phrase is one marked stretch, the spaces inside it included', () => {
  const words = wordDiff('await client.send(one two three, options)', 'await client.send(four five six, options)')
  assert.deepEqual(marked(words?.removed), ['one two three'])
  assert.deepEqual(marked(words?.added), ['four five six'])
})

test('an insertion marks only the added line; the removed line has nothing to mark', () => {
  const words = wordDiff('run(a, b)', 'run(a, extra, b)')
  assert.deepEqual(marked(words?.removed), [])
  assert.deepEqual(marked(words?.added), ['extra, '])
})

test('the words a pair shares stay unmarked, however few they are', () => {
  assert.deepEqual(marked(wordDiff('Pick from the lower branches', 'Pick from any branch')?.removed), ['the lower branches'])
  assert.deepEqual(marked(wordDiff('Pick from the lower branches', 'Pick from any branch')?.added), ['any branch'])
  assert.deepEqual(wordDiff('const x = 1', 'let y = 2'), {
    removed: [
      { text: 'const x', changed: true },
      { text: ' = ', changed: false },
      { text: '1', changed: true },
    ],
    added: [
      { text: 'let y', changed: true },
      { text: ' = ', changed: false },
      { text: '2', changed: true },
    ],
  })
})

test('a line that shares no word with its pair is marked whole', () => {
  assert.deepEqual(wordDiff('return total', 'throw new Error(message)'), {
    removed: [{ text: 'return total', changed: true }],
    added: [{ text: 'throw new Error(message)', changed: true }],
  })
  const diff = lineDiff('first line\nsecond line', 'completely different\nsecond line')
  const spans = changedSpans(diff)
  assert.deepEqual(spans.get(diff[0]), [{ text: 'first line', changed: true }])
  assert.deepEqual(spans.get(diff[1]), [{ text: 'completely different', changed: true }])
})

test('a pair past the word-edit cap is a rewrite, however much it shares', () => {
  // Sixty changed words, each beside a longer word both lines keep: most of
  // the visible text is shared, but the edits exceed the cap.
  const removed = Array.from({ length: 30 }, (_, index) => `key${index} v${index}`).join(' ')
  const added = removed.replaceAll(' v', ' w')
  assert.deepEqual(wordDiff(removed, added), {
    removed: [{ text: removed, changed: true }],
    added: [{ text: added, changed: true }],
  })
})

test('an empty line paired with a rewrite has nothing to mark', () => {
  assert.deepEqual(wordDiff('', 'brand new'), { removed: [], added: [{ text: 'brand new', changed: true }] })
})

test('lines past the length cap are not compared, and a pair of them is marked whole', () => {
  const long = `${'word '.repeat(100)}end`
  assert.equal(wordDiff(long, long.replace('end', 'stop')), null)
  assert.notEqual(wordDiff('word end', 'word stop'), null, 'the same edit on a short line is marked')
  const diff = lineDiff(`keep\n${long}\nkeep`, `keep\n${long.replace('end', 'stop')}\nkeep`)
  const spans = changedSpans(diff)
  const changed = diff.filter((entry) => entry.kind !== 'same')
  assert.deepEqual(
    changed.map((entry) => spans.get(entry)),
    changed.map((entry) => [{ text: entry.text, changed: true }]),
  )
})

test('changed lines pair in order within their run; a line left over stays whole', () => {
  const diff = lineDiff('keep\nalpha = 1\nbeta = 2\nkeep', 'keep\nalpha = 10\nbeta = 20\ngamma = 30\nkeep')
  const spans = changedSpans(diff)
  const byText = (text: string, kind: DiffLine['kind']) =>
    diff.find((entry) => entry.text === text && entry.kind === kind)
  assert.deepEqual(marked(spans.get(byText('alpha = 1', 'removed') as DiffLine)), ['1'])
  assert.deepEqual(marked(spans.get(byText('alpha = 10', 'added') as DiffLine)), ['10'])
  assert.deepEqual(marked(spans.get(byText('beta = 2', 'removed') as DiffLine)), ['2'])
  assert.deepEqual(marked(spans.get(byText('beta = 20', 'added') as DiffLine)), ['20'])
  assert.equal(spans.has(byText('gamma = 30', 'added') as DiffLine), false)
  assert.equal(spans.size, 4)
})

test('a run of only added or only removed lines has nothing to pair', () => {
  assert.equal(changedSpans(lineDiff('a\nc', 'a\nb\nc')).size, 0)
  assert.equal(changedSpans(lineDiff('a\nb\nc', 'a\nc')).size, 0)
})

test('a line in pieces keeps each word mark and each colour', () => {
  const spans = [
    { text: 'let a = ', changed: false },
    { text: '1', changed: true },
  ]
  const colours = [
    { start: 0, end: 3, style: '--shiki-light:keyword' },
    { start: 8, end: 9, style: '--shiki-light:number' },
  ]
  assert.deepEqual(linePieces('let a = 1', spans, colours), [
    { text: 'let', changed: false, style: '--shiki-light:keyword' },
    { text: ' a = ', changed: false, style: undefined },
    { text: '1', changed: true, style: '--shiki-light:number' },
  ])
  assert.deepEqual(linePieces('plain', spans.slice(0, 0), []), [{ text: 'plain', changed: false, style: undefined }])
})

test('a long line of many tokens keeps each piece its own mark and colour', () => {
  // Words coloured in turn and every third marked, between plain commas.
  const words = Array.from({ length: 3_000 }, (_, index) => `w${index}`)
  const text = words.join(',')
  const spans: LineSpan[] = []
  const colours: { start: number; end: number; style: string }[] = []
  const expected: { text: string; changed: boolean; style: string | undefined }[] = []
  let at = 0
  for (const [index, word] of words.entries()) {
    if (index > 0) {
      spans.push({ text: ',', changed: false })
      expected.push({ text: ',', changed: false, style: undefined })
      at += 1
    }
    const style = `--shiki-light:c${index % 2}`
    spans.push({ text: word, changed: index % 3 === 0 })
    colours.push({ start: at, end: at + word.length, style })
    expected.push({ text: word, changed: index % 3 === 0, style })
    at += word.length
  }
  // Piece by piece, so a failure names its piece instead of diffing the line.
  const pieces = linePieces(text, spans, colours)
  assert.equal(pieces.length, expected.length)
  for (const [index, piece] of expected.entries()) {
    assert.deepEqual(pieces[index], piece, `piece ${index}`)
  }
})

test('a coloured line draws its colours as tokens the host stylesheet themes', () => {
  const diff = lineDiff('let a = 1', 'let a = 2')
  const colours = new Map(diff.map((line) => [line, [{ start: 0, end: 3, style: '--shiki-light:#cf222e;--shiki-dark:#569cd6' }]]))
  const markup = renderToStaticMarkup(createElement(DiffView, { diff, variant: 'code', colours }))
  assert.match(markup, /<span class="shiki-token" style="--shiki-light:#cf222e;--shiki-dark:#569cd6">let<\/span>/)
})

test('word marks are square-cornered tints of the line colour', () => {
  const markup = renderToStaticMarkup(createElement(DiffView, { diff: lineDiff('a = 1', 'a = 2') }))
  assert.match(markup, /class="bg-destructive\/30">1</)
  assert.match(markup, /class="bg-success\/30">2</)
  assert.doesNotMatch(markup, /rounded/)
})

test('equal code says so in a tool call, and is shown as its lines in a code diff', () => {
  const diff = lineDiff('one\ntwo\nthree\nfour\nfive', 'one\ntwo\nthree\nfour\nfive')
  assert.match(renderToStaticMarkup(createElement(DiffView, { diff })), /No changes/)
  const code = renderToStaticMarkup(createElement(DiffView, { diff, variant: 'code' }))
  assert.doesNotMatch(code, /No changes|unchanged lines/)
  for (const line of ['one', 'two', 'three', 'four', 'five']) {
    assert.match(code, new RegExp(`>${line}</span>`))
  }
})
