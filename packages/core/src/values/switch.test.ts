import assert from 'node:assert/strict'
import test from 'node:test'

import { BOOLEAN_TYPE, NUMBER_TYPE, STRING_TYPE, switchCasesOf, switchConditionType, switchOutput } from './types'

const text = {
  inputTypes: { condition: STRING_TYPE },
  cases: [
    { id: 'c1', value: 'draft' },
    { id: 'c2', value: 'review' },
  ],
}

test('a boolean Switch routes true and false to their outputs', () => {
  assert.deepEqual(switchOutput({}, true), { ok: true, output: 'exec-true' })
  assert.deepEqual(switchOutput({ inputTypes: { condition: BOOLEAN_TYPE } }, false), {
    ok: true,
    output: 'exec-false',
  })
})

test('a text Switch routes a value equal to a case to that case, and any other to Default', () => {
  assert.deepEqual(switchOutput(text, 'review'), { ok: true, output: 'case-c2' })
  assert.deepEqual(switchOutput(text, 'published'), { ok: true, output: 'exec-default' })
  assert.deepEqual(switchOutput(text, 'Review'), { ok: true, output: 'exec-default' }, 'compared exactly')
  assert.deepEqual(switchOutput({ inputTypes: { condition: STRING_TYPE } }, 'draft'), {
    ok: true,
    output: 'exec-default',
  })
})

test("a Switch's condition has the type connected into it, a boolean before any was", () => {
  assert.equal(switchConditionType({}), BOOLEAN_TYPE)
  assert.equal(switchConditionType(text), STRING_TYPE)
  assert.equal(switchConditionType({ inputTypes: { condition: NUMBER_TYPE } }), BOOLEAN_TYPE, 'a type it does not take')
  assert.equal(switchConditionType({ inputTypes: 'text' }), BOOLEAN_TYPE)
})

test("a Switch's data.valueType is not read", () => {
  assert.equal(switchConditionType({ valueType: STRING_TYPE } as never), BOOLEAN_TYPE)
})

test('no condition value is an error, on either type', () => {
  assert.deepEqual(switchOutput({}, undefined), { ok: false, error: 'condition has no value' })
  assert.deepEqual(switchOutput(text, undefined), { ok: false, error: 'condition has no value' })
})

test("a boolean Switch's error for a text or a number condition names both types", () => {
  assert.deepEqual(switchOutput({}, 'draft'), {
    ok: false,
    error: 'condition is a text, and a boolean Switch routes on true or false',
  })
  assert.deepEqual(switchOutput({}, 1), {
    ok: false,
    error: 'condition is a number, and a boolean Switch routes on true or false',
  })
})

test('switchCasesOf leaves out what is not a case', () => {
  assert.deepEqual(switchCasesOf({ cases: [{ id: 'c1', value: 'a' }, { value: 'b' }, null, { id: '', value: 'c' }] }), [
    { id: 'c1', value: 'a' },
  ])
  assert.deepEqual(switchCasesOf({ cases: 'draft' }), [])
})
