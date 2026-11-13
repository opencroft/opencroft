// Get, and what a value node shows while an input it needs awaits a run.
import assert from 'node:assert/strict'
import test from 'node:test'

import { BOOLEAN_TYPE, NO_ENUMS, NUMBER_TYPE, OBJECT_TYPE, STRING_TYPE } from '@opencroft/core/values'

import {
  VALUE_NODE,
  valueNodeCheck,
  valueNodeDataProblems,
  valueNodeHandles,
  valueNodeOutput,
} from './value-nodes-shared'

const body = { user: { name: 'Ada', age: 36, tags: ['a'] } }

// A Get's data with `object` wired to `value` (or wired and awaiting a run, or unresolved).
function get(
  path: string,
  options: { valueType?: string; fallback?: unknown; object?: unknown; awaiting?: boolean } = {},
): Record<string, unknown> {
  const { valueType, fallback, object = body, awaiting } = options
  return {
    ...(valueType ? { valueType } : {}),
    inputs: { path, ...(fallback === undefined ? {} : { fallback }) },
    ...(awaiting
      ? { __unresolvedInputs: ['object'], __awaitingRun: ['object'] }
      : {
          __resolvedContexts: {
            object: { sourceNodeId: 'route', sourceHandleId: 'body', handleType: OBJECT_TYPE, value: object },
          },
        }),
  }
}

const value = (data: Record<string, unknown>) => valueNodeOutput(VALUE_NODE.get, 'value', data, NO_ENUMS)

test("Get's output and fallback take its value type; its object input takes no typed value", () => {
  const handles = valueNodeHandles(VALUE_NODE.get, { valueType: NUMBER_TYPE }, NO_ENUMS)
  assert.deepEqual(
    handles.map((h) => `${h.role}:${h.id}:${h.handleType}${h.inline === false ? ':wired' : ''}`),
    [
      `target:object:${OBJECT_TYPE}:wired`,
      `target:path:${STRING_TYPE}`,
      `target:fallback:${NUMBER_TYPE}`,
      `source:value:${NUMBER_TYPE}`,
    ],
  )
  assert.equal(valueNodeHandles(VALUE_NODE.get, { valueType: OBJECT_TYPE }, NO_ENUMS)[2].inline, false)
  assert.equal(valueNodeHandles(VALUE_NODE.get, {}, NO_ENUMS)[3].handleType, STRING_TYPE, 'text by default')
})

test('Get reads the value at its path when it is of its type', () => {
  assert.deepEqual(value(get('user.name')), { ok: true, value: 'Ada' })
  assert.deepEqual(value(get('user.age', { valueType: NUMBER_TYPE })), { ok: true, value: 36 })
  assert.deepEqual(value(get('user', { valueType: OBJECT_TYPE })), { ok: true, value: body.user })
  assert.deepEqual(value(get('user.tags.0')), { ok: true, value: 'a' })
})

test('a missing path gives the fallback, or an error naming the path without one', () => {
  assert.deepEqual(value(get('user.email', { fallback: 'none' })), { ok: true, value: 'none' })
  assert.deepEqual(value(get('user.email')), { ok: false, error: '"user.email" is not in the object' })
})

test('a value of another type is an error even with a fallback: nothing is converted', () => {
  assert.deepEqual(value(get('user.name', { valueType: NUMBER_TYPE, fallback: 0 })), {
    ok: false,
    error: '"user.name" is a text, not a number',
  })
  assert.deepEqual(value(get('user.age')), { ok: false, error: '"user.age" is a number, not a text' })
  assert.deepEqual(value(get('user.tags', { valueType: OBJECT_TYPE })), {
    ok: false,
    error: '"user.tags" is a list, not an object',
  })
  assert.equal(value(get('user.age', { valueType: BOOLEAN_TYPE }))?.ok, false)
})

test('a path that does not parse is the node error', () => {
  const data = get('user..name')
  assert.deepEqual(value(data), { ok: false, error: 'The path "user..name" has an empty segment at 2' })
  assert.equal(valueNodeCheck(VALUE_NODE.get, data, NO_ENUMS).length, 1)
})

test('while its object awaits a run, Get has nothing, whatever its fallback, and is not in error', () => {
  const data = get('user.age', { valueType: NUMBER_TYPE, fallback: 0, awaiting: true })
  assert.deepEqual(value(data), { ok: false, error: 'When it runs', awaitsRun: true })
  assert.deepEqual(valueNodeCheck(VALUE_NODE.get, data, NO_ENUMS), [])
})

test('a node fed by an input that awaits a run awaits it too; an unresolved one is in error', () => {
  const awaiting = { expression: 'a >= 18', __unresolvedInputs: ['var-a'], __awaitingRun: ['var-a'] }
  assert.equal(valueNodeOutput(VALUE_NODE.mathExpression, 'result', awaiting, NO_ENUMS)?.ok, false)
  assert.equal(
    (valueNodeOutput(VALUE_NODE.mathExpression, 'result', awaiting, NO_ENUMS) as { awaitsRun?: true }).awaitsRun,
    true,
  )
  assert.deepEqual(valueNodeCheck(VALUE_NODE.mathExpression, awaiting, NO_ENUMS), [])

  const unresolved = { expression: 'a >= 18', __unresolvedInputs: ['var-a'] }
  assert.equal(
    (valueNodeOutput(VALUE_NODE.mathExpression, 'result', unresolved, NO_ENUMS) as { awaitsRun?: true }).awaitsRun,
    undefined,
  )
  assert.equal(valueNodeCheck(VALUE_NODE.mathExpression, unresolved, NO_ENUMS).length, 1)
})

test("Get's value type is one of the four", () => {
  assert.deepEqual(valueNodeDataProblems(VALUE_NODE.get, { valueType: OBJECT_TYPE }), [])
  assert.equal(valueNodeDataProblems(VALUE_NODE.get, { valueType: 'acme.thing' }).length, 1)
})

test('Select takes objects, wired, once an object is connected into True or False', () => {
  const handles = valueNodeHandles(VALUE_NODE.select, { inputTypes: { value: OBJECT_TYPE } }, NO_ENUMS)
  assert.deepEqual(
    handles.filter((h) => h.id !== 'condition').map((h) => [h.id, h.handleType, h.inline]),
    [
      ['true', OBJECT_TYPE, false],
      ['false', OBJECT_TYPE, false],
      ['value', OBJECT_TYPE, undefined],
    ],
  )
  const data = {
    inputTypes: { value: OBJECT_TYPE },
    inputs: { condition: true },
    __resolvedContexts: {
      true: { sourceNodeId: 's', sourceHandleId: 'body', handleType: OBJECT_TYPE, value: { a: 1 } },
    },
  }
  assert.deepEqual(valueNodeOutput(VALUE_NODE.select, 'value', data, NO_ENUMS), { ok: true, value: { a: 1 } })
})
