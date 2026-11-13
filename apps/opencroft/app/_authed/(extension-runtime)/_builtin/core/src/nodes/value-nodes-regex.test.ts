import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_PATTERN_LENGTH, NO_ENUMS, STRING_TYPE } from '@opencroft/core/values'
import { RE2JS } from 're2js'

import {
  VALUE_NODE,
  valueNodeCheck,
  valueNodeDataProblems,
  valueNodeExposed,
  valueNodeHandles,
  valueNodeOutputs,
} from './value-nodes-shared'

const search = VALUE_NODE.regexSearch
const replace = VALUE_NODE.regexReplace

const ids = (type: typeof search | typeof replace, data: Record<string, unknown>) =>
  valueNodeHandles(type, data, NO_ENUMS).map((h) => `${h.role === 'target' ? 'in' : 'out'}:${h.id}:${h.handleType}`)

// What the resolvers write into a node's data for a text wired into `id`.
function wiredText(id: string, value: unknown) {
  return {
    __resolvedContexts: { [id]: { sourceNodeId: 'src', sourceHandleId: 'out', handleType: STRING_TYPE, value } },
  }
}

const DATE = '(?<year>\\d{4})-(?<month>\\d{2})'

test('Regex Search has an output per capture group of its pattern, named or numbered', () => {
  assert.deepEqual(ids(search, { pattern: DATE }), [
    'in:text:builtin.core.string',
    'out:matched:builtin.core.boolean',
    'out:match:builtin.core.string',
    'out:group-year:builtin.core.string',
    'out:group-month:builtin.core.string',
  ])
  const mixed = valueNodeHandles(search, { pattern: '(\\d+)-(?<unit>[a-z]+)' }, NO_ENUMS).slice(3)
  assert.deepEqual(
    mixed.map((h) => [h.id, h.label]),
    [
      ['group-1', 'Group 1'],
      ['group-unit', 'unit'],
    ],
  )
})

test("renaming a group changes its output's id, so an edge on the old id ends at a pin the node does not have", () => {
  const renamed = ids(search, { pattern: '(?<y>\\d{4})-(?<month>\\d{2})' })
  assert.ok(!renamed.includes('out:group-year:builtin.core.string'))
  assert.ok(renamed.includes('out:group-y:builtin.core.string'))
})

test('a named group keeps its output when a group is added before it', () => {
  const added = ids(search, { pattern: `(report) ${DATE}` })
  assert.ok(added.includes('out:group-year:builtin.core.string'))
  assert.ok(added.includes('out:group-1:builtin.core.string'))
})

test('Regex Search outputs the first match and its groups', () => {
  const data = { pattern: DATE, inputs: { text: 'report 2026-10.pdf' } }
  assert.equal(valueNodeExposed(search, 'matched', data, NO_ENUMS), true)
  assert.equal(valueNodeExposed(search, 'match', data, NO_ENUMS), '2026-10')
  assert.equal(valueNodeExposed(search, 'group-year', data, NO_ENUMS), '2026')
  assert.equal(valueNodeExposed(search, 'group-month', data, NO_ENUMS), '10')
  const wired = { pattern: DATE, ...wiredText('text', 'from 1999-12 to 2000-01') }
  assert.equal(valueNodeExposed(search, 'group-year', wired, NO_ENUMS), '1999', 'a wired text is searched')
})

test('with no match Matched is false and Match and every group are empty texts', () => {
  const data = { pattern: DATE, inputs: { text: 'no date' } }
  assert.equal(valueNodeExposed(search, 'matched', data, NO_ENUMS), false)
  assert.equal(valueNodeExposed(search, 'match', data, NO_ENUMS), '')
  assert.equal(valueNodeExposed(search, 'group-year', data, NO_ENUMS), '')
  assert.deepEqual(valueNodeCheck(search, data, NO_ENUMS), [])
})

test('Ignore case matches letters in either case', () => {
  assert.equal(valueNodeExposed(search, 'matched', { pattern: 'pdf', inputs: { text: 'A.PDF' } }, NO_ENUMS), false)
  assert.equal(
    valueNodeExposed(search, 'matched', { pattern: 'pdf', ignoreCase: true, inputs: { text: 'A.PDF' } }, NO_ENUMS),
    true,
  )
})

test('a pattern that does not compile is one check error, and leaves every output empty', () => {
  const data = { pattern: '(\\w)\\1', inputs: { text: 'aa' } }
  const errors = valueNodeCheck(search, data, NO_ENUMS)
  assert.equal(errors.length, 1)
  assert.match(errors[0].title, /^Backreferences such as \\1 are not supported/)
  assert.equal(errors[0].detail, 'The Matched, Match outputs have no value.')
  assert.equal(valueNodeExposed(search, 'matched', data, NO_ENUMS), undefined)
  assert.deepEqual(ids(search, data).slice(3), [], 'no group outputs while it does not compile')
  assert.deepEqual(
    valueNodeCheck(search, { pattern: '' }, NO_ENUMS).map((e) => e.title),
    ['The pattern is empty'],
  )
})

test('Regex Replace substitutes the groups into every match, or the first, and counts them', () => {
  const data = { pattern: '(\\w+)@(\\w+)', inputs: { text: 'ann@home bob@work', replacement: '$2 at $1' } }
  assert.deepEqual(ids(replace, data), [
    'in:text:builtin.core.string',
    'in:replacement:builtin.core.string',
    'out:text:builtin.core.string',
    'out:count:builtin.core.number',
  ])
  assert.equal(valueNodeExposed(replace, 'text', data, NO_ENUMS), 'home at ann work at bob')
  assert.equal(valueNodeExposed(replace, 'count', data, NO_ENUMS), 2)
  const first = { ...data, all: false }
  assert.equal(valueNodeExposed(replace, 'text', first, NO_ENUMS), 'home at ann bob@work')
  assert.equal(valueNodeExposed(replace, 'count', first, NO_ENUMS), 1)
})

test('Regex Replace with no match outputs the text unchanged and a count of 0; no replacement removes', () => {
  const data = { pattern: '\\d+', inputs: { text: 'no digits' } }
  assert.equal(valueNodeExposed(replace, 'text', data, NO_ENUMS), 'no digits')
  assert.equal(valueNodeExposed(replace, 'count', data, NO_ENUMS), 0)
  assert.equal(valueNodeExposed(replace, 'text', { pattern: '\\s+', inputs: { text: 'a b  c' } }, NO_ENUMS), 'abc')
})

test('a replacement naming a group the pattern does not have is a check error', () => {
  const data = { pattern: '(a)(b)', inputs: { text: 'ab', replacement: '$3' } }
  assert.deepEqual(
    valueNodeCheck(replace, data, NO_ENUMS).map((e) => e.title),
    ['$3: the pattern has 2 groups'],
  )
  assert.equal(valueNodeExposed(replace, 'text', data, NO_ENUMS), undefined)
})

test('data problems: a pattern that is not a text or is too long, and toggles that are not true or false', () => {
  assert.deepEqual(
    valueNodeDataProblems(search, { pattern: 3, ignoreCase: 'yes' }).map((p) => p.path),
    ['pattern', 'ignoreCase'],
  )
  assert.deepEqual(
    valueNodeDataProblems(replace, { pattern: 'a'.repeat(MAX_PATTERN_LENGTH + 1), all: 1 }).map((p) => p.path),
    ['pattern', 'all'],
  )
  assert.deepEqual(valueNodeDataProblems(search, { pattern: '(' }), [], 'a pattern that does not compile is a check')
})

test("a pattern is compiled once however often the node's handles, outputs and checks read it", (t) => {
  const compile = t.mock.method(RE2JS, 'compile')
  const pattern = '(?<compiledOnce>\\d+)-(\\w+)'
  const read = (text: string) => {
    const data = { pattern, inputs: { text } }
    valueNodeHandles(search, data, NO_ENUMS)
    for (const id of ['matched', 'match', 'group-compiledOnce', 'group-2']) {
      valueNodeExposed(search, id, data, NO_ENUMS)
    }
    valueNodeOutputs(search, data, NO_ENUMS)
    valueNodeCheck(search, data, NO_ENUMS)
  }
  read('12-ab')
  read('34-cd')
  assert.equal(compile.mock.callCount(), 1, 'one compile for one pattern')
  valueNodeExposed(search, 'matched', { pattern: `${pattern}x`, inputs: { text: '1-ax' } }, NO_ENUMS)
  valueNodeExposed(search, 'matched', { pattern, ignoreCase: true, inputs: { text: '1-a' } }, NO_ENUMS)
  assert.equal(compile.mock.callCount(), 3, 'one more per distinct pattern or flags')
})

test("a node's outputs share one search of the same text", (t) => {
  const matcher = t.mock.method(RE2JS.prototype, 'matcher')
  const data = { pattern: '(?<sharedSearch>\\d+)', inputs: { text: 'a 1' } }
  for (const id of ['matched', 'match', 'group-sharedSearch']) {
    valueNodeExposed(search, id, data, NO_ENUMS)
  }
  valueNodeCheck(search, data, NO_ENUMS)
  assert.equal(matcher.mock.callCount(), 1)
})
