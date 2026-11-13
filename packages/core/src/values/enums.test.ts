import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acceptedTypesPhrase,
  BOOLEAN_TYPE,
  type EnumCasesField,
  type EnumCasesOf,
  handleTakes,
  handleTypesConnect,
  inputTypeOf,
  inputValue,
  NUMBER_TYPE,
  readValue,
  STRING_TYPE,
  switchConditionType,
  switchOutput,
  typedValueProblem,
  withEnumCases,
} from './types'

const FORMAT = 'acme.images.format'
const CASES = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
]
const enums: EnumCasesOf = (type) => (type === FORMAT ? CASES : undefined)
const format = { id: 'format', handleType: FORMAT, cases: CASES }

test('an enum connects to its own type and widens into a text input, and nothing else connects into it', () => {
  assert.equal(handleTypesConnect(FORMAT, FORMAT, true), true)
  assert.equal(handleTypesConnect(FORMAT, STRING_TYPE, true), true)
  assert.equal(handleTypesConnect(FORMAT, STRING_TYPE), false, 'a type not known as an enum does not widen')
  assert.equal(handleTypesConnect(FORMAT, NUMBER_TYPE, true), false)
  assert.equal(handleTypesConnect(FORMAT, 'acme.images.other', true), false)
  assert.equal(handleTypesConnect(STRING_TYPE, FORMAT), false)
  assert.equal(handleTypesConnect(NUMBER_TYPE, FORMAT), false)
})

test('an input that takes every enum takes an enum source, and one without acceptsEnums does not', () => {
  const condition = { handleType: BOOLEAN_TYPE, accepts: [BOOLEAN_TYPE, STRING_TYPE], acceptsEnums: true }
  assert.equal(handleTakes(condition, FORMAT, { isEnum: true }), true)
  assert.equal(handleTakes(condition, FORMAT), false, 'not told it is an enum')
  assert.equal(handleTakes({ ...condition, acceptsEnums: undefined }, FORMAT, { isEnum: true }), false)
  assert.equal(handleTakes({ handleType: STRING_TYPE }, FORMAT, { isEnum: true }), true, 'a text input reads it')
})

test('the type stored for an input that takes every enum is read as an enum when it is no value type', () => {
  const condition = { id: 'condition', handleType: BOOLEAN_TYPE, accepts: [BOOLEAN_TYPE, STRING_TYPE] }
  assert.equal(inputTypeOf({ inputTypes: { condition: FORMAT } }, { ...condition, acceptsEnums: true }), FORMAT)
  assert.equal(inputTypeOf({ inputTypes: { condition: FORMAT } }, condition), BOOLEAN_TYPE)
  assert.equal(
    inputTypeOf({ inputTypes: { condition: NUMBER_TYPE } }, { ...condition, acceptsEnums: true }),
    BOOLEAN_TYPE,
    'a value type it does not list stays refused',
  )
  assert.equal(switchConditionType({ inputTypes: { condition: FORMAT } }), FORMAT)
})

test('an enum input reads a case value and nothing else', () => {
  assert.equal(readValue(format, 'png'), 'png')
  assert.equal(readValue(format, 'gif'), undefined)
  assert.equal(readValue(format, 1), undefined)
  assert.equal(inputValue({ inputs: { format: 'jpeg' } }, format), 'jpeg')
  assert.equal(inputValue({ inputs: { format: 'gif' } }, { ...format, default: 'png' }), 'png')
  assert.equal(inputValue({}, format, { value: 'webp' }), 'webp')
})

test('a typed value that is not a case is refused, naming the cases', () => {
  assert.equal(typedValueProblem(format, 'png'), null)
  assert.equal(typedValueProblem(format, 'gif'), 'must be one of: png, jpeg, webp')
  assert.equal(typedValueProblem(format, 3), 'must be one of: png, jpeg, webp')
})

test("withEnumCases gives each handle of an enum type the enum's cases, and keeps the list when none has one", () => {
  const plain = [{ id: 'n', handleType: NUMBER_TYPE }]
  assert.equal(withEnumCases(plain, enums), plain)
  const declared: ({ id: string; handleType: string } & EnumCasesField)[] = [{ id: 'format', handleType: FORMAT }]
  const [resolved] = withEnumCases(declared, enums)
  assert.deepEqual(resolved.cases, CASES)
})

test("an enum input's phrase lists its cases' labels, and one that takes every enum says so", () => {
  assert.equal(acceptedTypesPhrase(format), 'PNG, JPEG or WebP')
  assert.equal(
    acceptedTypesPhrase({ handleType: BOOLEAN_TYPE, accepts: [BOOLEAN_TYPE, STRING_TYPE], acceptsEnums: true }),
    'true/false, a text or an enum',
  )
})

test('a Switch on an enum routes a case to its output by value, and any other value to Default', () => {
  const settings = { inputTypes: { condition: FORMAT } }
  assert.deepEqual(switchOutput(settings, 'jpeg', CASES), { ok: true, output: 'case-jpeg' })
  assert.deepEqual(switchOutput(settings, 'gif', CASES), { ok: true, output: 'exec-default' })
  assert.deepEqual(switchOutput(settings, 'png', []), { ok: true, output: 'exec-default' }, 'an enum that is gone')
  assert.deepEqual(switchOutput(settings, undefined, CASES), { ok: false, error: 'condition has no value' })
  assert.deepEqual(switchOutput(settings, 2, CASES), { ok: true, output: 'exec-default' })
  assert.deepEqual(switchOutput(settings, true, CASES), { ok: true, output: 'exec-default' }, 'kept from a boolean')
})

test('an input that takes several types takes only a case as its typed value while it is on an enum', () => {
  const condition = {
    id: 'condition',
    handleType: FORMAT,
    accepts: [BOOLEAN_TYPE, STRING_TYPE],
    acceptsEnums: true,
    cases: CASES.slice(0, 2),
  }
  assert.equal(typedValueProblem(condition, 'png'), null)
  assert.equal(typedValueProblem(condition, 'webp'), 'must be one of: png, jpeg', 'a case the enum no longer has')
  assert.equal(typedValueProblem(condition, 'hello'), 'must be one of: png, jpeg', 'kept from a text')
  assert.equal(typedValueProblem(condition, true), 'must be one of: png, jpeg', 'kept from a boolean')
  const onText = { id: 'condition', handleType: STRING_TYPE, accepts: [BOOLEAN_TYPE, STRING_TYPE], acceptsEnums: true }
  assert.equal(typedValueProblem(onText, true), null, 'on a text it keeps a value of another type it lists')
})
