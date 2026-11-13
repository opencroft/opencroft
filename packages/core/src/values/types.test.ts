import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOOLEAN_TYPE,
  handleTypesConnect,
  inputValue,
  isPrimitiveType,
  isValueType,
  NUMBER_TYPE,
  OBJECT_TYPE,
  readValue,
  STRING_TYPE,
  typedValueProblem,
  type ValueHandle,
} from './types'

const OTHER = 'acme.widgets.signal'

test('equal types connect, and a number or a boolean widens into a string', () => {
  assert.equal(handleTypesConnect(STRING_TYPE, STRING_TYPE), true)
  assert.equal(handleTypesConnect(NUMBER_TYPE, NUMBER_TYPE), true)
  assert.equal(handleTypesConnect(OTHER, OTHER), true)
  assert.equal(handleTypesConnect(NUMBER_TYPE, STRING_TYPE), true)
  assert.equal(handleTypesConnect(BOOLEAN_TYPE, STRING_TYPE), true)
})

test('every other change of type does not connect', () => {
  assert.equal(handleTypesConnect(STRING_TYPE, NUMBER_TYPE), false)
  assert.equal(handleTypesConnect(STRING_TYPE, BOOLEAN_TYPE), false)
  assert.equal(handleTypesConnect(NUMBER_TYPE, BOOLEAN_TYPE), false)
  assert.equal(handleTypesConnect(BOOLEAN_TYPE, NUMBER_TYPE), false)
  assert.equal(handleTypesConnect(OTHER, STRING_TYPE), false)
  assert.equal(handleTypesConnect(NUMBER_TYPE, OTHER), false)
})

test('isPrimitiveType names the three types only', () => {
  assert.equal(isPrimitiveType(STRING_TYPE), true)
  assert.equal(isPrimitiveType(NUMBER_TYPE), true)
  assert.equal(isPrimitiveType(BOOLEAN_TYPE), true)
  assert.equal(isPrimitiveType(OTHER), false)
  assert.equal(isPrimitiveType(undefined), false)
})

test('readValue converts across a widening edge and rounds an integer input', () => {
  const text = { handleType: STRING_TYPE }
  assert.equal(readValue(text, 42), '42')
  assert.equal(readValue(text, 0.5), '0.5')
  assert.equal(readValue(text, true), 'true')
  assert.equal(readValue(text, Number.NaN), undefined)
  assert.equal(readValue(text, { a: 1 }), undefined)
  assert.equal(readValue({ handleType: NUMBER_TYPE }, 2.6), 2.6)
  assert.equal(readValue({ handleType: NUMBER_TYPE, integer: true }, 2.6), 3)
  assert.equal(readValue({ handleType: NUMBER_TYPE }, '2'), undefined)
  assert.equal(readValue({ handleType: NUMBER_TYPE }, Number.POSITIVE_INFINITY), undefined)
  assert.equal(readValue({ handleType: BOOLEAN_TYPE }, false), false)
  assert.equal(readValue({ handleType: BOOLEAN_TYPE }, 'true'), undefined)
  assert.equal(readValue({ handleType: OTHER }, 'x'), undefined)
})

const width: ValueHandle = { id: 'width', handleType: NUMBER_TYPE, default: 1024, integer: true, min: 1 }

test('inputValue reads the wired value first, then the typed one, then the default', () => {
  const typed = { inputs: { width: 640 } }
  assert.equal(inputValue(typed, width, { value: 800.4 }), 800)
  assert.equal(inputValue(typed, width), 640)
  assert.equal(inputValue({}, width), 1024)
  assert.equal(inputValue(undefined, { id: 'w', handleType: NUMBER_TYPE }), undefined)
})

test('a wired input reads nothing else, even while its source exposes nothing', () => {
  assert.equal(inputValue({ inputs: { width: 640 } }, width, null), undefined)
  // A wired value of a type the handle does not read is not replaced by the typed one.
  assert.equal(inputValue({ inputs: { width: 640 } }, width, { value: 'wide' }), undefined)
})

test('inputValue skips the typed value of an input declared inline: false', () => {
  assert.equal(inputValue({ inputs: { width: 640 } }, { ...width, inline: false }), 1024)
})

test('a typed value of the wrong type falls back to the default', () => {
  assert.equal(inputValue({ inputs: { width: 'wide' } }, width), 1024)
  assert.equal(inputValue({ inputs: 'nope' }, width), 1024)
  assert.equal(inputValue({ inputs: ['x'] }, width), 1024)
})

test('inputValue reads only the inputs object’s own keys', () => {
  const inputs = Object.create({ width: 5 })
  assert.equal(inputValue({ inputs }, width), 1024)
  assert.equal(inputValue({ inputs: {} }, { id: 'toString', handleType: STRING_TYPE }), undefined)
})

test('a typed value is read through the handle’s type, as a wired one is', () => {
  assert.equal(inputValue({ inputs: { width: 2.4 } }, width), 2)
  assert.equal(inputValue({ inputs: { label: 7 } }, { id: 'label', handleType: STRING_TYPE }), '7')
})

test('typedValueProblem checks the type and the declared limits', () => {
  assert.equal(typedValueProblem(width, 10), null)
  assert.equal(typedValueProblem(width, '10'), 'must be a number')
  assert.equal(typedValueProblem(width, Number.NaN), 'must be a number')
  assert.equal(typedValueProblem(width, 2.5), 'must be a whole number')
  assert.equal(typedValueProblem(width, 0), 'must be at least 1')
  assert.equal(typedValueProblem({ ...width, max: 4096 }, 5000), 'must be at most 4096')
  assert.equal(typedValueProblem({ id: 'on', handleType: BOOLEAN_TYPE }, 'true'), 'must be true or false')
  assert.equal(typedValueProblem({ id: 'on', handleType: BOOLEAN_TYPE }, false), null)
  const fit: ValueHandle = {
    id: 'fit',
    handleType: STRING_TYPE,
    options: [{ value: 'cover' }, { value: 'contain', label: 'Contain' }],
  }
  assert.equal(typedValueProblem(fit, 'cover'), null)
  assert.equal(typedValueProblem(fit, 'fill'), 'must be one of: cover, contain')
  assert.equal(typedValueProblem({ id: 's', handleType: STRING_TYPE }, 3), 'must be a string')
  assert.equal(typedValueProblem({ id: 'x', handleType: OTHER }, 3), null)
})

test('the object is a value type, not a primitive, and connects only to an object', () => {
  assert.equal(isValueType(OBJECT_TYPE), true)
  assert.equal(isPrimitiveType(OBJECT_TYPE), false)
  assert.equal(isValueType(OTHER), false)
  assert.equal(handleTypesConnect(OBJECT_TYPE, OBJECT_TYPE), true)
  assert.equal(handleTypesConnect(OBJECT_TYPE, STRING_TYPE), false)
  assert.equal(handleTypesConnect(STRING_TYPE, OBJECT_TYPE), false)
})

test('an object input reads a plain object, and nothing else', () => {
  const object = { handleType: OBJECT_TYPE }
  assert.deepEqual(readValue(object, { a: 1 }), { a: 1 })
  assert.equal(readValue(object, [1]), undefined)
  assert.equal(readValue(object, null), undefined)
  assert.equal(readValue(object, 'a'), undefined)
})

test('an object input takes no typed value: it reads only what is wired', () => {
  const handle: ValueHandle = { id: 'object', handleType: OBJECT_TYPE }
  assert.equal(typedValueProblem(handle, { a: 1 }), 'takes no typed value: connect an object to it')
  assert.equal(inputValue({ inputs: { object: { a: 1 } } }, handle), undefined)
  assert.deepEqual(inputValue({}, handle, { value: { b: 2 } }), { b: 2 })
})
