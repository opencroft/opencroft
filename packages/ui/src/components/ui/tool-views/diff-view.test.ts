import assert from 'node:assert/strict'
import test from 'node:test'

import { type DiffLine, diffStats, foldUnchanged, lineDiff } from './diff-view'

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
