// The value nodes on an enum: a Switch's outputs follow the enum's cases, a
// Select picks among its values, and a new Switch case never takes the id of
// a deleted one.
import assert from 'node:assert/strict'
import test from 'node:test'

import { type EnumCasesOf, NO_ENUMS, RESOLVED_CONTEXTS_KEY, STRING_TYPE } from '@opencroft/core/values'

import {
  newSwitchCaseId,
  VALUE_NODE,
  valueNodeCheck,
  valueNodeHandles,
  valueNodeOutput,
  withSwitchCaseIds,
} from './value-nodes-shared'

const FORMAT = 'acme.images.format'
const CASES = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
]
const enums: EnumCasesOf = (type) => (type === FORMAT ? CASES : undefined)
const onFormat = { inputTypes: { condition: FORMAT } }

test('a Switch on an enum has one output per case, by value and labelled, in order, then Default', () => {
  const outputs = valueNodeHandles(VALUE_NODE.switch, onFormat, enums).filter((h) => h.role === 'source')
  assert.deepEqual(
    outputs.map((h) => [h.id, h.label]),
    [
      ['case-png', 'PNG'],
      ['case-jpeg', 'JPEG'],
      ['case-webp', 'WebP'],
      ['exec-default', 'Default'],
    ],
  )
})

test("a Switch on an enum no loaded extension declares has Default only, so its cases' edges are stale", () => {
  const outputs = valueNodeHandles(VALUE_NODE.switch, onFormat, NO_ENUMS).filter((h) => h.role === 'source')
  assert.deepEqual(
    outputs.map((h) => h.id),
    ['exec-default'],
  )
})

test("a Switch's condition takes every enum, and has the enum's type once one is connected", () => {
  const [, condition] = valueNodeHandles(VALUE_NODE.switch, onFormat, enums)
  assert.equal(condition.acceptsEnums, true)
  assert.equal(condition.handleType, FORMAT)
  assert.equal(valueNodeHandles(VALUE_NODE.switch, {}, enums)[1].acceptsEnums, true, 'before anything is connected')
})

test("Select's True and False take every enum, and on an enum Value carries it and reads the chosen case", () => {
  const data = { inputTypes: { value: FORMAT }, inputs: { true: 'png', false: 'webp', condition: true } }
  const handles = valueNodeHandles(VALUE_NODE.select, data, enums)
  assert.deepEqual(
    handles.map((h) => [h.id, h.handleType, h.acceptsEnums ?? false]),
    [
      ['condition', 'builtin.core.boolean', false],
      ['true', FORMAT, true],
      ['false', FORMAT, true],
      ['value', FORMAT, false],
    ],
  )
  assert.deepEqual(valueNodeOutput(VALUE_NODE.select, 'value', data, enums), { ok: true, value: 'png' })
  assert.deepEqual(
    valueNodeOutput(VALUE_NODE.select, 'value', { ...data, inputs: { ...data.inputs, condition: false } }, enums),
    {
      ok: true,
      value: 'webp',
    },
  )
})

test('a Select on an enum reads a typed True or False that is not a case as nothing, and its check says so', () => {
  const data = { inputTypes: { value: FORMAT }, inputs: { true: 'png', false: 'hello', condition: false } }
  assert.deepEqual(valueNodeOutput(VALUE_NODE.select, 'value', data, enums), {
    ok: false,
    error: 'False has no value',
  })
  assert.deepEqual(
    valueNodeCheck(VALUE_NODE.select, data, enums).map((e) => e.title),
    ['False has no value'],
  )
  const wired = {
    ...data,
    [RESOLVED_CONTEXTS_KEY]: {
      false: { sourceNodeId: 'n', sourceHandleId: 'format', handleType: FORMAT, value: 'jpeg' },
    },
  }
  assert.deepEqual(valueNodeOutput(VALUE_NODE.select, 'value', wired, enums), { ok: true, value: 'jpeg' })
})

test('a text input wired from an enum is not wired from the wrong type', () => {
  const data = {
    template: 'image.{ext}',
    [RESOLVED_CONTEXTS_KEY]: {
      'arg-ext': { sourceNodeId: 'n', sourceHandleId: 'format', handleType: FORMAT, value: 'png' },
    },
  }
  assert.deepEqual(valueNodeCheck(VALUE_NODE.format, data, enums), [])
  assert.deepEqual(valueNodeOutput(VALUE_NODE.format, 'text', data, enums), { ok: true, value: 'image.png' })
})

test('a number input wired from an enum is wired from the wrong type', () => {
  const data = {
    expression: 'a + 1',
    [RESOLVED_CONTEXTS_KEY]: {
      'var-a': { sourceNodeId: 'n', sourceHandleId: 'format', handleType: FORMAT, value: 'png' },
    },
  }
  const titles = valueNodeCheck(VALUE_NODE.mathExpression, data, enums).map((e) => e.title)
  assert.ok(titles.includes('a is wired from the wrong type'), titles.join('; '))
})

test('a new Switch case never takes the id of a deleted one', () => {
  const deleted = 'c1'
  const left = [{ id: 'c2', value: 'review' }]
  const ids = new Set(Array.from({ length: 200 }, () => newSwitchCaseId(left)))
  assert.equal(ids.has(deleted), false)
  assert.equal(ids.has('c2'), false)
  assert.equal(ids.size, 200, 'each one new')
})

test('a case written without an id is given one that no case has', () => {
  const data = {
    inputTypes: { condition: STRING_TYPE },
    cases: [{ id: 'c2', value: 'review' }, { value: 'draft' }, { value: 'published' }],
  }
  const cases = withSwitchCaseIds(data).cases as { id: string; value: string }[]
  assert.equal(cases[0].id, 'c2')
  assert.equal(new Set(cases.map((c) => c.id)).size, 3)
  assert.ok(cases.every((c) => /^c[0-9a-f]{8}$/.test(c.id) || c.id === 'c2'))
})
