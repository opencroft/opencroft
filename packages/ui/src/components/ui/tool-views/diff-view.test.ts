import assert from 'node:assert/strict'
import test from 'node:test'

import { changedSpans, type DiffLine, diffStats, foldUnchanged, type LineSpan, lineDiff, wordDiff } from './diff-view'

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

test('a rewritten line is marked whole, not in part', () => {
  assert.deepEqual(wordDiff('const x = 1', 'let y = 2'), {
    removed: [{ text: 'const x = 1', changed: true }],
    added: [{ text: 'let y = 2', changed: true }],
  })
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
  // Sixty changed words, each beside a longer word both lines keep: well over
  // half of the visible text is shared, but the edits exceed the cap.
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

test('lines past the length cap are not compared', () => {
  const long = `${'word '.repeat(100)}end`
  assert.equal(wordDiff(long, long.replace('end', 'stop')), null)
  assert.notEqual(wordDiff('word end', 'word stop'), null, 'the same edit on a short line is marked')
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
