import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acceptedTypesPhrase,
  BOOLEAN_TYPE,
  handleTakes,
  inputTypeOf,
  inputValue,
  NUMBER_TYPE,
  STRING_TYPE,
  typedValueProblem,
  type ValueHandle,
  withInputType,
  withTypesNow,
} from './types'

const condition: ValueHandle = { id: 'condition', handleType: BOOLEAN_TYPE, accepts: [BOOLEAN_TYPE, STRING_TYPE] }
const branch = { handleType: STRING_TYPE, accepts: [STRING_TYPE, NUMBER_TYPE, BOOLEAN_TYPE], typeGroup: 'value' }

test('an input that takes several types takes exactly those, nothing widened into it', () => {
  assert.equal(handleTakes(condition, BOOLEAN_TYPE), true)
  assert.equal(handleTakes(condition, STRING_TYPE), true)
  assert.equal(handleTakes(condition, NUMBER_TYPE), false)
  assert.equal(handleTakes(condition, 'acme.widgets.signal'), false)
})

test('an input that takes one type takes the same type, or a number or a boolean into a text', () => {
  const text = { handleType: STRING_TYPE }
  assert.equal(handleTakes(text, NUMBER_TYPE), true)
  assert.equal(handleTakes(text, BOOLEAN_TYPE), true)
  assert.equal(handleTakes({ handleType: NUMBER_TYPE }, STRING_TYPE), false)
})

test('while another input of its group is wired, a several-type input takes only the type the group has', () => {
  const asNumber = { ...branch, handleType: NUMBER_TYPE }
  assert.equal(handleTakes(asNumber, NUMBER_TYPE, { groupWired: true }), true)
  assert.equal(handleTakes(asNumber, STRING_TYPE, { groupWired: true }), false)
  assert.equal(handleTakes(asNumber, STRING_TYPE), true)
})

test('an enum reaches only an input that accepts every enum', () => {
  assert.equal(handleTakes(condition, 'acme.widgets.status', { isEnum: true }), false)
  assert.equal(handleTakes({ ...condition, acceptsEnums: true }, 'acme.widgets.status', { isEnum: true }), true)
})

test('the type now is the one stored for the group when the input accepts it, else its handleType', () => {
  assert.equal(inputTypeOf({}, condition), BOOLEAN_TYPE)
  assert.equal(inputTypeOf({ inputTypes: { condition: STRING_TYPE } }, condition), STRING_TYPE)
  assert.equal(inputTypeOf({ inputTypes: { condition: NUMBER_TYPE } }, condition), BOOLEAN_TYPE)
  assert.equal(inputTypeOf({ inputTypes: { value: NUMBER_TYPE } }, { id: 'false', ...branch }), NUMBER_TYPE)
  assert.equal(
    inputTypeOf({ inputTypes: { condition: STRING_TYPE } }, { id: 'n', handleType: NUMBER_TYPE }),
    NUMBER_TYPE,
  )
})

test('withTypesNow gives each several-type input its type now and leaves the rest as they are', () => {
  const handles = [
    { ...condition, role: 'target' },
    { id: 'exec-true', handleType: 'builtin.core.execution-context', role: 'source' },
  ]
  assert.equal(withTypesNow(handles, {}), handles, 'nothing changes')
  const now = withTypesNow(handles, { inputTypes: { condition: STRING_TYPE } })
  assert.equal(now[0].handleType, STRING_TYPE)
  assert.deepEqual(now[0].accepts, [BOOLEAN_TYPE, STRING_TYPE])
  assert.equal(now[1], handles[1])
})

test('withInputType sets one group and keeps the others, and returns the data itself when it is set', () => {
  const data = { inputTypes: { a: NUMBER_TYPE } }
  assert.deepEqual(withInputType(data, 'b', STRING_TYPE), { inputTypes: { a: NUMBER_TYPE, b: STRING_TYPE } })
  assert.equal(withInputType(data, 'a', NUMBER_TYPE), data)
})

test('a typed value of another type the input takes is kept and not read, nor read as its text', () => {
  const asText = { ...condition, handleType: STRING_TYPE }
  assert.equal(inputValue({ inputs: { condition: true } }, asText), undefined)
  assert.equal(inputValue({ inputs: { condition: 'draft' } }, asText), 'draft')
  assert.equal(inputValue({ inputs: { condition: 'draft' } }, { ...condition, default: false }), false)
})

test('the default of a several-type input applies only while it has the default’s type', () => {
  assert.equal(inputValue({}, { ...condition, default: false }), false)
  assert.equal(inputValue({}, { ...condition, handleType: STRING_TYPE, default: false }), undefined)
})

test('a several-type input takes a typed value of any type it accepts', () => {
  assert.equal(typedValueProblem(condition, 'draft'), null)
  assert.equal(typedValueProblem(condition, true), null)
  assert.equal(typedValueProblem(condition, 3), 'must be true or false')
})

test('acceptedTypesPhrase names what an input takes', () => {
  assert.equal(acceptedTypesPhrase(condition), 'true/false or a text')
  assert.equal(acceptedTypesPhrase(branch), 'a text, a number or true/false')
  assert.equal(acceptedTypesPhrase({ handleType: NUMBER_TYPE }), 'a number')
})
