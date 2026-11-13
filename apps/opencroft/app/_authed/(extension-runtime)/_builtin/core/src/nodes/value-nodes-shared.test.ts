import assert from 'node:assert/strict'
import test from 'node:test'

import { BOOLEAN_TYPE, type EnumCasesOf, NO_ENUMS, NUMBER_TYPE, OBJECT_TYPE, STRING_TYPE } from '@opencroft/core/values'

import {
  choicesFeeding,
  EXECUTION_TYPE,
  VALUE_NODE,
  valueNodeCheck,
  valueNodeDataProblems,
  valueNodeExposed,
  valueNodeHandles,
  valueNodeOutput,
  valueNodeTypeOf,
  withSwitchCaseIds,
} from './value-nodes-shared'

// What the resolvers write into a node's data for each wired input.
function wired(entries: Record<string, { value: unknown; handleType?: string }>, unresolved: string[] = []) {
  const contexts = Object.fromEntries(
    Object.entries(entries).map(([id, e]) => [
      id,
      { sourceNodeId: 'src', sourceHandleId: 'out', handleType: e.handleType ?? NUMBER_TYPE, value: e.value },
    ]),
  )
  return { __resolvedContexts: contexts, ...(unresolved.length > 0 ? { __unresolvedInputs: unresolved } : {}) }
}

const ids = (type: Parameters<typeof valueNodeHandles>[0], data: Record<string, unknown>) =>
  valueNodeHandles(type, data, NO_ENUMS).map((h) => `${h.role === 'target' ? 'in' : 'out'}:${h.id}:${h.handleType}`)

test('value nodes are known by their qualified type, and no other node is', () => {
  assert.equal(valueNodeTypeOf('builtin.core.math-expression'), VALUE_NODE.mathExpression)
  assert.equal(valueNodeTypeOf('builtin.core.subgraph'), undefined)
  assert.equal(valueNodeTypeOf('acme.widgets.switch'), undefined)
})

test('Math Expression has a number input per variable, and a result typed by its top operator', () => {
  assert.deepEqual(ids(VALUE_NODE.mathExpression, { expression: 'a * 2 + b * a' }), [
    `in:var-a:${NUMBER_TYPE}`,
    `in:var-b:${NUMBER_TYPE}`,
    `out:result:${NUMBER_TYPE}`,
  ])
  assert.deepEqual(ids(VALUE_NODE.mathExpression, { expression: 'x > 2' }), [
    `in:var-x:${NUMBER_TYPE}`,
    `out:result:${BOOLEAN_TYPE}`,
  ])
  assert.deepEqual(ids(VALUE_NODE.mathExpression, { expression: 'pi * e' }), [`out:result:${NUMBER_TYPE}`])
})

test('a Math Expression variable used with &&, || or ! is a boolean input, defaulting to false', () => {
  const data = { expression: 'ready && !blocked || n > 3' }
  assert.deepEqual(ids(VALUE_NODE.mathExpression, data), [
    `in:var-ready:${BOOLEAN_TYPE}`,
    `in:var-blocked:${BOOLEAN_TYPE}`,
    `in:var-n:${NUMBER_TYPE}`,
    `out:result:${BOOLEAN_TYPE}`,
  ])
  assert.deepEqual(valueNodeOutput(VALUE_NODE.mathExpression, 'result', data, NO_ENUMS), { ok: true, value: false })
  const typed = { ...data, inputs: { 'var-ready': true } }
  assert.deepEqual(valueNodeOutput(VALUE_NODE.mathExpression, 'result', typed, NO_ENUMS), { ok: true, value: true })
  const wiredIn = {
    ...data,
    ...wired({ 'var-blocked': { value: true, handleType: BOOLEAN_TYPE } }),
    inputs: { 'var-ready': true },
  }
  assert.deepEqual(valueNodeOutput(VALUE_NODE.mathExpression, 'result', wiredIn, NO_ENUMS), { ok: true, value: false })
})

test('Format has a text input per distinct placeholder', () => {
  assert.deepEqual(ids(VALUE_NODE.format, { template: '{name}_{n:03}_{name}.png' }), [
    `in:arg-name:${STRING_TYPE}`,
    `in:arg-n:${STRING_TYPE}`,
    `out:text:${STRING_TYPE}`,
  ])
})

test('a Math Expression variable that == or ? : alone decides takes a number or a boolean, in its group', () => {
  const equal = { expression: 'a == b' }
  assert.deepEqual(ids(VALUE_NODE.mathExpression, equal), [
    `in:var-a:${NUMBER_TYPE}`,
    `in:var-b:${NUMBER_TYPE}`,
    `out:result:${BOOLEAN_TYPE}`,
  ])
  const [a, b] = valueNodeHandles(VALUE_NODE.mathExpression, equal, NO_ENUMS)
  assert.deepEqual(a.accepts, [NUMBER_TYPE, BOOLEAN_TYPE])
  assert.equal(a.typeGroup, 'var-a')
  assert.equal(b.typeGroup, 'var-a', 'variables compared with each other share one type')
  assert.equal(a.default, 0)
  const booleans = { ...equal, inputTypes: { 'var-a': BOOLEAN_TYPE } }
  assert.deepEqual(ids(VALUE_NODE.mathExpression, booleans), [
    `in:var-a:${BOOLEAN_TYPE}`,
    `in:var-b:${BOOLEAN_TYPE}`,
    `out:result:${BOOLEAN_TYPE}`,
  ])
  assert.equal(valueNodeHandles(VALUE_NODE.mathExpression, booleans, NO_ENUMS)[1].default, false)
  assert.equal(
    valueNodeHandles(VALUE_NODE.mathExpression, { expression: 'a && b' }, NO_ENUMS)[0].accepts,
    undefined,
    'a variable the expression types takes that type only',
  )
})

test("a Math Expression result that has a free group's type follows what is connected into it", () => {
  assert.deepEqual(ids(VALUE_NODE.mathExpression, { expression: 'c ? x : y' }), [
    `in:var-c:${BOOLEAN_TYPE}`,
    `in:var-x:${NUMBER_TYPE}`,
    `in:var-y:${NUMBER_TYPE}`,
    `out:result:${NUMBER_TYPE}`,
  ])
  const booleans = { expression: 'c ? x : y', inputTypes: { 'var-x': BOOLEAN_TYPE } }
  assert.equal(ids(VALUE_NODE.mathExpression, booleans)[3], `out:result:${BOOLEAN_TYPE}`)
  const picked = {
    ...booleans,
    inputs: { 'var-c': true },
    ...wired({ 'var-x': { value: true, handleType: BOOLEAN_TYPE } }),
  }
  assert.deepEqual(valueNodeOutput(VALUE_NODE.mathExpression, 'result', picked, NO_ENUMS), { ok: true, value: true })
  assert.deepEqual(valueNodeCheck(VALUE_NODE.mathExpression, picked, NO_ENUMS), [])
})

test('a Math Expression variable keeps a value typed for another type, and does not read it', () => {
  const data = { expression: 'a && b', inputs: { 'var-a': 4, 'var-b': true } }
  assert.deepEqual(valueNodeOutput(VALUE_NODE.mathExpression, 'result', data, NO_ENUMS), { ok: true, value: false })
  assert.deepEqual(
    valueNodeOutput(
      VALUE_NODE.mathExpression,
      'result',
      { ...data, inputs: { 'var-a': true, 'var-b': true } },
      NO_ENUMS,
    ),
    { ok: true, value: true },
  )
})

test('Text Compare: is, is not, contains, starts with and ends with, with or without case', () => {
  const cmp = (op: string, a: unknown, b: unknown, ignoreCase = false) =>
    valueNodeExposed(VALUE_NODE.textCompare, 'result', { op, ignoreCase, inputs: { a, b } }, NO_ENUMS)
  assert.equal(cmp('ends-with', 'Report.PDF', '.pdf', true), true)
  assert.equal(cmp('ends-with', 'Report.PDF', '.pdf'), false)
  assert.equal(cmp('contains', 'Report.PDF', 'port'), true)
  assert.equal(cmp('contains', 'Report.PDF', 'PORT'), false)
  assert.equal(cmp('starts-with', 'Report.PDF', 'rep', true), true)
  assert.equal(cmp('is', 'png', 'png'), true)
  assert.equal(cmp('is-not', 'png', 'PNG'), true)
  assert.equal(cmp('is-not', 'png', 'PNG', true), false)
  assert.equal(cmp('unknown', 'png', 'png'), true, 'any other operator is "is"')
  assert.equal(cmp('ends-with', 'anything', ''), true, 'an empty B ends every text')
  assert.equal(cmp('is', 'x', ''), false, '"is" an empty B tests for an empty text')
  // NFC: a composed é is a decomposed e and its accent.
  assert.equal(cmp('is', '\u{e9}', 'e\u{301}'), true)
  assert.equal(cmp('is', 'Straße', 'STRASSE', true), false, 'case is lowercased, not folded')
  assert.deepEqual(ids(VALUE_NODE.textCompare, {}), [
    `in:a:${STRING_TYPE}`,
    `in:b:${STRING_TYPE}`,
    `out:result:${BOOLEAN_TYPE}`,
  ])
  const wiredNumber = { op: 'is', ...wired({ a: { value: 42 } }), inputs: { b: '42' } }
  assert.equal(
    valueNodeExposed(VALUE_NODE.textCompare, 'result', wiredNumber, NO_ENUMS),
    true,
    'a number reads as its text',
  )
  assert.deepEqual(valueNodeCheck(VALUE_NODE.textCompare, wiredNumber, NO_ENUMS), [])
})

test('Compare, And, Or and Not are not value nodes', () => {
  for (const name of ['compare', 'and', 'or', 'not']) {
    assert.equal(valueNodeTypeOf(`builtin.core.${name}`), undefined)
  }
})

test("Select's True, False and Value have the type connected into True or False, a text before any was", () => {
  assert.deepEqual(ids(VALUE_NODE.select, {}), [
    `in:condition:${BOOLEAN_TYPE}`,
    `in:true:${STRING_TYPE}`,
    `in:false:${STRING_TYPE}`,
    `out:value:${STRING_TYPE}`,
  ])
  assert.deepEqual(ids(VALUE_NODE.select, { inputTypes: { value: NUMBER_TYPE } }), [
    `in:condition:${BOOLEAN_TYPE}`,
    `in:true:${NUMBER_TYPE}`,
    `in:false:${NUMBER_TYPE}`,
    `out:value:${NUMBER_TYPE}`,
  ])
  assert.equal(ids(VALUE_NODE.select, { valueType: NUMBER_TYPE })[1], `in:true:${STRING_TYPE}`, 'valueType is not read')
  const [, branch] = valueNodeHandles(VALUE_NODE.select, {}, NO_ENUMS)
  assert.deepEqual(branch.accepts, [STRING_TYPE, NUMBER_TYPE, BOOLEAN_TYPE, OBJECT_TYPE])
  assert.equal(branch.typeGroup, 'value')
})

test("Switch's outputs follow the type connected into its condition", () => {
  assert.deepEqual(ids(VALUE_NODE.switch, {}), [
    `in:exec-in:${EXECUTION_TYPE}`,
    `in:condition:${BOOLEAN_TYPE}`,
    `out:exec-true:${EXECUTION_TYPE}`,
    `out:exec-false:${EXECUTION_TYPE}`,
  ])
  assert.deepEqual(valueNodeHandles(VALUE_NODE.switch, {}, NO_ENUMS)[1].accepts, [BOOLEAN_TYPE, STRING_TYPE])
  assert.equal(ids(VALUE_NODE.switch, { valueType: STRING_TYPE })[1], `in:condition:${BOOLEAN_TYPE}`)
  const text = {
    inputTypes: { condition: STRING_TYPE },
    cases: [
      { id: 'c2', value: 'review' },
      { id: 'c1', value: 'draft' },
    ],
  }
  assert.deepEqual(ids(VALUE_NODE.switch, text), [
    `in:exec-in:${EXECUTION_TYPE}`,
    `in:condition:${STRING_TYPE}`,
    `out:case-c2:${EXECUTION_TYPE}`,
    `out:case-c1:${EXECUTION_TYPE}`,
    `out:exec-default:${EXECUTION_TYPE}`,
  ])
  assert.equal(valueNodeHandles(VALUE_NODE.switch, text, NO_ENUMS)[2].label, 'review')
  assert.equal(valueNodeHandles(VALUE_NODE.switch, {}, NO_ENUMS)[0].multiple, true)
})

test('Format fills its template, formatting a wired number before it is text', () => {
  const data = { template: '{name}_{n:03}.png', ...wired({ 'arg-n': { value: 7 } }), inputs: { 'arg-name': 'cat' } }
  assert.deepEqual(valueNodeOutput(VALUE_NODE.format, 'text', data, NO_ENUMS), { ok: true, value: 'cat_007.png' })
  assert.deepEqual(valueNodeOutput(VALUE_NODE.format, 'text', { template: '{name}.png' }, NO_ENUMS), {
    ok: false,
    error: 'Nothing to put in {name}',
  })
})

test('Math Expression computes from its typed and wired variables, and says why it has no value', () => {
  assert.deepEqual(
    valueNodeOutput(VALUE_NODE.mathExpression, 'result', { expression: 'a * 2 + 1', inputs: { 'var-a': 3 } }, NO_ENUMS),
    {
      ok: true,
      value: 7,
    },
  )
  assert.deepEqual(
    valueNodeOutput(
      VALUE_NODE.mathExpression,
      'result',
      { expression: 'a * 2', ...wired({ 'var-a': { value: 4 } }) },
      NO_ENUMS,
    ),
    {
      ok: true,
      value: 8,
    },
  )
  assert.deepEqual(valueNodeOutput(VALUE_NODE.mathExpression, 'result', { expression: 'a / 0' }, NO_ENUMS), {
    ok: false,
    error: 'Division by zero',
  })
  const parse = valueNodeOutput(VALUE_NODE.mathExpression, 'result', { expression: 'a + )' }, NO_ENUMS)
  assert.equal(parse?.ok, false)
  assert.match(parse?.ok === false ? parse.error : '', /at 5$/)
  assert.deepEqual(
    valueNodeOutput(VALUE_NODE.mathExpression, 'result', { expression: 'x > 2', inputs: { 'var-x': 3 } }, NO_ENUMS),
    {
      ok: true,
      value: true,
    },
  )
})

test('an input that is wired reads only its wire, even while its source exposes nothing', () => {
  const data = { expression: 'a + 1', inputs: { 'var-a': 3 }, ...wired({}, ['var-a']) }
  assert.deepEqual(valueNodeOutput(VALUE_NODE.mathExpression, 'result', data, NO_ENUMS), {
    ok: false,
    error: 'No number for "a"',
  })
})

test('Math Expression evaluates the right side of && only when it is needed', () => {
  const data = { expression: 'b != 0 && a / b > 1', inputs: { 'var-a': 4, 'var-b': 0 } }
  assert.deepEqual(valueNodeOutput(VALUE_NODE.mathExpression, 'result', data, NO_ENUMS), { ok: true, value: false })
})

// A Convert to `to` fed `value` wired from its own type.
function converted(to: string, value: string | number | boolean) {
  const from = typeof value === 'number' ? NUMBER_TYPE : typeof value === 'boolean' ? BOOLEAN_TYPE : STRING_TYPE
  const data = { valueType: to, inputTypes: { value: from }, ...wired({ value: { value, handleType: from } }) }
  return valueNodeOutput(VALUE_NODE.convert, 'value', data, NO_ENUMS)
}

test('Convert to a number reads a decimal text, and true as 1 and false as 0', () => {
  assert.deepEqual(converted(NUMBER_TYPE, ' -0.5 '), { ok: true, value: -0.5 })
  assert.deepEqual(converted(NUMBER_TYPE, '1e3'), { ok: true, value: 1000 })
  assert.deepEqual(converted(NUMBER_TYPE, 'abc'), { ok: false, error: '"abc" is not a number' })
  assert.deepEqual(converted(NUMBER_TYPE, ''), { ok: false, error: '"" is not a number' })
  assert.deepEqual(converted(NUMBER_TYPE, 7), { ok: true, value: 7 })
  assert.deepEqual(converted(NUMBER_TYPE, true), { ok: true, value: 1 })
  assert.deepEqual(converted(NUMBER_TYPE, false), { ok: true, value: 0 })
})

test('Convert to a boolean reads true, false, 1 and 0, from a text or a number', () => {
  assert.deepEqual(converted(BOOLEAN_TYPE, ' true '), { ok: true, value: true })
  assert.deepEqual(converted(BOOLEAN_TYPE, '0'), { ok: true, value: false })
  assert.deepEqual(converted(BOOLEAN_TYPE, 'yes'), { ok: false, error: '"yes" is not true, false, 1 or 0' })
  assert.deepEqual(converted(BOOLEAN_TYPE, 1), { ok: true, value: true })
  assert.deepEqual(converted(BOOLEAN_TYPE, 0), { ok: true, value: false })
  assert.deepEqual(converted(BOOLEAN_TYPE, 2), { ok: false, error: '"2" is not true, false, 1 or 0' })
  assert.deepEqual(converted(BOOLEAN_TYPE, false), { ok: true, value: false })
})

test('Convert to text writes a value as Format does', () => {
  assert.deepEqual(converted(STRING_TYPE, 0.5), { ok: true, value: '0.5' })
  assert.deepEqual(converted(STRING_TYPE, true), { ok: true, value: 'true' })
  assert.deepEqual(converted(STRING_TYPE, 'cat'), { ok: true, value: 'cat' })
})

test('Convert reads a typed text while nothing is wired, and converts to a number before a type is set', () => {
  assert.equal(valueNodeExposed(VALUE_NODE.convert, 'value', { inputs: { value: '42' } }, NO_ENUMS), 42)
  assert.deepEqual(valueNodeOutput(VALUE_NODE.convert, 'value', {}, NO_ENUMS), {
    ok: false,
    error: 'Value has no value',
  })
})

test('Convert’s input takes a text, a number or a boolean, and its output has the type it converts to', () => {
  assert.deepEqual(ids(VALUE_NODE.convert, {}), [`in:value:${STRING_TYPE}`, `out:value:${NUMBER_TYPE}`])
  assert.deepEqual(ids(VALUE_NODE.convert, { valueType: BOOLEAN_TYPE, inputTypes: { value: NUMBER_TYPE } }), [
    `in:value:${NUMBER_TYPE}`,
    `out:value:${BOOLEAN_TYPE}`,
  ])
  const [input] = valueNodeHandles(VALUE_NODE.convert, {}, NO_ENUMS)
  assert.deepEqual(input.accepts, [STRING_TYPE, NUMBER_TYPE, BOOLEAN_TYPE])
})

test('Select outputs the input its condition picks', () => {
  const data = { inputTypes: { value: NUMBER_TYPE }, inputs: { true: 1, false: 2 } }
  assert.equal(
    valueNodeExposed(VALUE_NODE.select, 'value', { ...data, inputs: { ...data.inputs, condition: true } }, NO_ENUMS),
    1,
  )
  assert.equal(valueNodeExposed(VALUE_NODE.select, 'value', data, NO_ENUMS), 2, 'the condition defaults to false')
})

const FORMATS = 'acme.images.format'
const formatCases: EnumCasesOf = (type) =>
  type === FORMATS ? [{ value: 'png', label: 'PNG' }, { value: 'jpeg' }] : undefined

test('a Value outputs what is set on it, of its type, and its type’s default while nothing is', () => {
  assert.equal(valueNodeExposed(VALUE_NODE.value, 'value', { value: 'cat' }, NO_ENUMS), 'cat', 'text before a type')
  assert.equal(valueNodeExposed(VALUE_NODE.value, 'value', { valueType: NUMBER_TYPE, value: 3 }, NO_ENUMS), 3)
  assert.equal(valueNodeExposed(VALUE_NODE.value, 'value', { valueType: BOOLEAN_TYPE }, NO_ENUMS), false)
  assert.equal(valueNodeExposed(VALUE_NODE.value, 'value', { valueType: NUMBER_TYPE }, NO_ENUMS), 0)
  assert.equal(valueNodeExposed(VALUE_NODE.value, 'value', {}, NO_ENUMS), '')
  assert.equal(valueNodeOutput(VALUE_NODE.switch, 'exec-true', {}, NO_ENUMS), undefined, 'Switch exposes no value')
})

test('a Value’s output has its type, an enum’s included', () => {
  assert.deepEqual(ids(VALUE_NODE.value, {}), [`out:value:${STRING_TYPE}`])
  assert.deepEqual(ids(VALUE_NODE.value, { valueType: BOOLEAN_TYPE }), [`out:value:${BOOLEAN_TYPE}`])
  assert.deepEqual(ids(VALUE_NODE.value, { valueType: FORMATS }), [`out:value:${FORMATS}`])
  assert.deepEqual(ids(VALUE_NODE.value, { valueType: OBJECT_TYPE }), [`out:value:${STRING_TYPE}`], 'not an object')
})

test('a Value of an enum holds one of its cases, the first while nothing is set', () => {
  assert.equal(valueNodeExposed(VALUE_NODE.value, 'value', { valueType: FORMATS, value: 'jpeg' }, formatCases), 'jpeg')
  assert.equal(valueNodeExposed(VALUE_NODE.value, 'value', { valueType: FORMATS }, formatCases), 'png')
  assert.deepEqual(valueNodeOutput(VALUE_NODE.value, 'value', { valueType: FORMATS, value: 'gif' }, formatCases), {
    ok: false,
    error: '"gif" is not one of: png, jpeg',
  })
  assert.deepEqual(valueNodeOutput(VALUE_NODE.value, 'value', { valueType: FORMATS, value: 'png' }, NO_ENUMS), {
    ok: false,
    error: `No loaded extension declares the type ${FORMATS}`,
  })
})

test('a Value whose value is not of its type converts nothing: it is the node’s error', () => {
  const data = { valueType: NUMBER_TYPE, value: '3' }
  assert.deepEqual(valueNodeOutput(VALUE_NODE.value, 'value', data, NO_ENUMS), {
    ok: false,
    error: 'The value is a text, not a number',
  })
  assert.deepEqual(
    valueNodeCheck(VALUE_NODE.value, data, NO_ENUMS).map((e) => e.title),
    ['The value is a text, not a number'],
  )
  assert.deepEqual(valueNodeDataProblems(VALUE_NODE.value, data), [], 'the write is not refused')
})

test('a node check reports an output with no value, and an input wired from a type it does not take', () => {
  assert.deepEqual(
    valueNodeCheck(VALUE_NODE.mathExpression, { expression: 'a / 0' }, NO_ENUMS).map((e) => e.title),
    ['Division by zero'],
  )
  assert.deepEqual(valueNodeCheck(VALUE_NODE.mathExpression, { expression: 'a / 2' }, NO_ENUMS), [])
  const booleanIntoNumber = {
    expression: 'a + 1',
    ...wired({ 'var-a': { value: true, handleType: BOOLEAN_TYPE } }),
  }
  assert.deepEqual(
    valueNodeCheck(VALUE_NODE.mathExpression, booleanIntoNumber, NO_ENUMS).map((e) => e.title),
    ['a is wired from the wrong type', 'No number for "a"'],
  )
  const numberIntoText = { ...wired({ a: { value: 1 } }), inputs: { b: '1' } }
  assert.deepEqual(
    valueNodeCheck(VALUE_NODE.textCompare, numberIntoText, NO_ENUMS),
    [],
    'a number widens into a text input',
  )
  const booleanIntoTextSwitch = {
    inputTypes: { condition: STRING_TYPE },
    ...wired({ condition: { value: true, handleType: BOOLEAN_TYPE } }),
  }
  assert.deepEqual(
    valueNodeCheck(VALUE_NODE.switch, booleanIntoTextSwitch, NO_ENUMS).map((e) => e.title),
    ['Condition is wired from the wrong type'],
    'wired, an input that takes several types takes only the type it has now',
  )
  const numberIntoTextSelect = {
    inputTypes: { value: STRING_TYPE },
    ...wired({ true: { value: 1 }, false: { value: 'b', handleType: STRING_TYPE } }),
  }
  const errors = valueNodeCheck(VALUE_NODE.select, numberIntoTextSelect, NO_ENUMS)
  assert.deepEqual(
    errors.map((e) => e.title),
    ['True is wired from the wrong type'],
    'no widening into an input of Select’s group',
  )
  assert.equal(errors[0].detail, `It has the type ${STRING_TYPE} now and is wired from ${NUMBER_TYPE}.`)
})

test('data problems: the settings types, and Switch cases distinct and non-empty', () => {
  assert.deepEqual(
    valueNodeDataProblems(VALUE_NODE.value, { valueType: 3, value: [1] }).map((p) => p.path),
    ['valueType', 'value'],
  )
  assert.deepEqual(
    valueNodeDataProblems(VALUE_NODE.value, { valueType: NUMBER_TYPE, value: Number.NaN }).map((p) => p.path),
    ['value'],
  )
  assert.deepEqual(
    valueNodeDataProblems(VALUE_NODE.convert, { valueType: OBJECT_TYPE }).map((p) => p.path),
    ['valueType'],
    'Convert converts to text, a number or a boolean only',
  )
  assert.deepEqual(
    valueNodeDataProblems(VALUE_NODE.textCompare, { op: '==', ignoreCase: 'yes' }).map((p) => p.path),
    ['op', 'ignoreCase'],
  )
  assert.deepEqual(valueNodeDataProblems(VALUE_NODE.textCompare, { op: 'ends-with', ignoreCase: true }), [])
  assert.deepEqual(
    valueNodeDataProblems(VALUE_NODE.mathExpression, { expression: 'a +' }),
    [],
    'a parse error is a check',
  )
  const cases = (list: unknown) => valueNodeDataProblems(VALUE_NODE.switch, { cases: list }).map((p) => p.title)
  assert.deepEqual(cases([{ value: 'draft' }, { id: 'c1', value: 'review' }]), [], 'an id is given on write')
  assert.deepEqual(cases([{ id: 'c1', value: '' }]), ['A case must not be empty'])
  assert.deepEqual(cases([{ value: 'a' }, { value: 'a' }]), ['"a" is a case already'])
  assert.deepEqual(
    cases([
      { id: 'c1', value: 'a' },
      { id: 'c1', value: 'b' },
    ]),
    ['The id "c1" is taken by another case'],
  )
})

test('a case written without an id is given one, and the data is kept when none is missing', () => {
  const data = { cases: [{ id: 'c1', value: 'a' }, { value: 'b' }, { value: 'c' }] }
  const cases = withSwitchCaseIds(data).cases as { id: string; value: string }[]
  assert.deepEqual(
    cases.map((c) => c.value),
    ['a', 'b', 'c'],
  )
  assert.equal(cases[0].id, 'c1')
  assert.equal(new Set(cases.map((c) => c.id)).size, 3)
  const whole = { cases: [{ id: 'c1', value: 'a' }] }
  assert.equal(withSwitchCaseIds(whole), whole)
})

test("an input feeding a text Switch's condition starts with its cases as choices", () => {
  const cases = [
    { id: 'a', value: 'llama' },
    { id: 'b', value: 'qwen' },
  ]
  const text = { type: 'builtin.core.switch', data: { inputTypes: { condition: STRING_TYPE }, cases } }
  assert.deepEqual(choicesFeeding(text, 'condition'), [{ value: 'llama' }, { value: 'qwen' }])
  assert.equal(choicesFeeding({ ...text, data: { cases } }, 'condition'), undefined, 'a boolean Switch has no cases')
  assert.equal(choicesFeeding(text, 'exec-in'), undefined)
  assert.equal(choicesFeeding({ type: 'builtin.core.select', data: text.data }, 'condition'), undefined)
})
