import assert from 'node:assert/strict'
import test from 'node:test'

import { editSides } from './edit-sides'

const edit = { oldString: 'retries = 3', newString: 'retries = 5', replaceAll: false }
const BEFORE = 'const a = 1\nretries = 3\nconst b = 2\n'
const AFTER = 'const a = 1\nretries = 5\nconst b = 2\n'

test('before approval, the live text is the "before" and the edit is applied forward', () => {
  assert.deepEqual(editSides('approval', BEFORE, edit), { original: BEFORE, value: AFTER, whole: true })
})

test('after the call, the live text is the "after" and the "before" is worked back', () => {
  assert.deepEqual(editSides('history', AFTER, edit), { original: BEFORE, value: AFTER, whole: true })
})

test('a replace-all is applied forward before approval', () => {
  const all = { oldString: 'x', newString: 'y', replaceAll: true }
  assert.deepEqual(editSides('approval', 'x x\nx', all), { original: 'x x\nx', value: 'y y\ny', whole: true })
})

test('a replace-all is not worked back: replaced occurrences cannot be told from ones already there', () => {
  const all = { oldString: 'x', newString: 'y', replaceAll: true }
  assert.deepEqual(editSides('history', 'y y\ny', all), { original: 'x', value: 'y', whole: false })
})

test('replacement text is inserted literally, as the tools insert it', () => {
  const dollars = { oldString: 'price', newString: 'cost $& $$ $1', replaceAll: false }
  assert.deepEqual(editSides('approval', 'the price\n', dollars), {
    original: 'the price\n',
    value: 'the cost $& $$ $1\n',
    whole: true,
  })
  assert.deepEqual(editSides('history', 'the cost $& $$ $1\n', dollars), {
    original: 'the price\n',
    value: 'the cost $& $$ $1\n',
    whole: true,
  })
})

test('a replacement that also occurs elsewhere is not worked back, since the wrong one could be picked', () => {
  // Before: "bar()\nfoo()"; the edit turned foo() into bar(). Working back from
  // the first bar() would mark the line that never changed.
  const ambiguous = { oldString: 'foo()', newString: 'bar()', replaceAll: false }
  assert.deepEqual(editSides('history', 'bar()\nbar()\n', ambiguous), {
    original: 'foo()',
    value: 'bar()',
    whole: false,
  })
})

test('a text worked back that would hold the replaced text twice is not trusted', () => {
  // The tool rejects an oldString that is not unique, so a "before" with two
  // copies of it is not a state the edit could have started from.
  const edit = { oldString: 'a', newString: 'b', replaceAll: false }
  assert.deepEqual(editSides('history', 'a\nb\n', edit), { original: 'a', value: 'b', whole: false })
})

test('before approval, an edit the tool would reject is shown as its snippet', () => {
  const repeated = { oldString: 'x', newString: 'y', replaceAll: false }
  assert.deepEqual(editSides('approval', 'x\nx\n', repeated), { original: 'x', value: 'y', whole: false })
})

test('without the live text, the diff is of the replaced snippet', () => {
  const snippet = { original: 'retries = 3', value: 'retries = 5', whole: false }
  assert.deepEqual(editSides('approval', null, edit), snippet)
  assert.deepEqual(editSides('history', null, edit), snippet)
})

test('a live text that no longer carries the edit falls back to the snippet', () => {
  // A later change overwrote the edit: working back from this text would show
  // a diff of nothing, or of the wrong place.
  assert.deepEqual(editSides('history', BEFORE, edit), { original: 'retries = 3', value: 'retries = 5', whole: false })
  assert.deepEqual(editSides('approval', AFTER, edit), { original: 'retries = 3', value: 'retries = 5', whole: false })
})

test('a deletion is not worked back: an empty replacement matches everywhere', () => {
  const deletion = { oldString: 'retries = 3\n', newString: '', replaceAll: false }
  assert.deepEqual(editSides('history', 'const a = 1\nconst b = 2\n', deletion), {
    original: 'retries = 3\n',
    value: '',
    whole: false,
  })
})
