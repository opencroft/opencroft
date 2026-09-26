import assert from 'node:assert/strict'
import test from 'node:test'

import { readableJson } from './op-block'

// Shapes a tool answer takes: nesting, empty containers at every depth, and
// strings holding the characters the layout itself reacts to.
const VALUES: unknown[] = [
  { tasks: [{ key: 'T-1', labels: ['a', 'b'], childCount: 3, done: false, assignee: null }], total: 1 },
  [{ ref: 'x', threads: [] }, { ref: 'y', threads: [{ title: 'z', contextUsage: { usedTokens: 5 } }] }],
  { empty: {}, none: [], nested: { deeper: { list: [[], {}, [1, [2, []]]] } } },
  { text: 'braces { and } brackets [ and ], a comma, a colon: here' },
  { quoted: 'she said "hi"', backslash: 'C:\\path\\', newline: 'two\nlines', tab: 'a\tb' },
  { unicode: 'naïve — ✓', emoji: '🙂' },
  [],
  {},
  [1, -2.5, 3e-7, true, false, null, 'x'],
]

test('compact JSON is laid out exactly as JSON.stringify(value, null, 2) lays it out', () => {
  for (const value of VALUES) {
    assert.equal(readableJson(JSON.stringify(value)), JSON.stringify(value, null, 2))
  }
})

test('JSON that is already indented comes back unchanged', () => {
  for (const value of VALUES) {
    const indented = JSON.stringify(value, null, 2)
    assert.equal(readableJson(indented), indented)
  }
})

test('values are copied as written, never parsed and printed again', () => {
  // A round trip through JSON.parse would print 12345678901234567000, 1.5 and é.
  assert.equal(
    readableJson('{"id":12345678901234567890,"price":1.50,"name":"caf\\u00e9"}'),
    '{\n  "id": 12345678901234567890,\n  "price": 1.50,\n  "name": "caf\\u00e9"\n}',
  )
})

test('text that is not a JSON object or array is returned as it came', () => {
  for (const text of ['Found 3 pages', '', '42', '"a string"', 'null', '{not json', '[1, 2', 'Action run completed.']) {
    assert.equal(readableJson(text), text)
  }
})
