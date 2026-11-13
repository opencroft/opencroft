// Connecting an enum: into a Switch's condition or a Select's True, which take
// its type, into a text input, which reads its text, and never from a text
// into an enum input.
import assert from 'node:assert/strict'
import test from 'node:test'

import { type EnumCasesOf, STRING_TYPE } from '@opencroft/core/values'

import { valueNodeHandles } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/value-nodes-shared'
import { declaredHandlesOf } from '@/app/_authed/(extension-runtime)/_declared-handles'
import {
  connectRefusal,
  dataOnConnect,
  takesEdge,
  withFollowedTypes,
} from '@/app/_authed/(extension-runtime)/_input-types'
import { introducedProblems } from '@/app/_authed/(extension-runtime)/_node-data-problems'
import { typedInputProblems } from '@/app/_authed/(extension-runtime)/_typed-inputs'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

const FORMAT = 'acme.images.format'
const CASES = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
]
const enums: EnumCasesOf = (type) => (type === FORMAT ? CASES : undefined)
const CONVERT = 'acme.images.convert'
const convertHandles: ExtensionHandle[] = [
  { id: 'format', role: 'target', handleType: FORMAT },
  { id: 'chosen', role: 'source', handleType: FORMAT },
]
const handlesOfType = (type: string) => (type === CONVERT ? convertHandles : [])

test('connecting an enum into a Switch sets its type, so its outputs are the cases and Default', () => {
  const [, condition] = valueNodeHandles('switch', {}, enums)
  assert.equal(takesEdge('s', [condition], condition, FORMAT, [], true), true)
  const data = dataOnConnect({}, condition, FORMAT, true)
  assert.deepEqual(data, { inputTypes: { condition: FORMAT } })
  const outputs = declaredHandlesOf({ type: 'builtin.core.switch', data }, handlesOfType, enums)
    .filter((h) => h.role === 'source')
    .map((h) => h.id)
  assert.deepEqual(outputs, ['case-png', 'case-jpeg', 'exec-default'])
  assert.deepEqual(dataOnConnect({}, condition, FORMAT), {}, 'a source not known as an enum sets nothing')
})

test("connecting an enum into a Select's True sets True, False and Value to it", () => {
  const handles = valueNodeHandles('select', {}, enums)
  const branch = handles[1]
  const data = dataOnConnect({}, branch, FORMAT, true)
  const now = declaredHandlesOf({ type: 'builtin.core.select', data }, handlesOfType, enums)
  assert.deepEqual(
    now.map((h) => h.handleType),
    ['builtin.core.boolean', FORMAT, FORMAT, FORMAT],
  )
  assert.deepEqual(now[1].cases, CASES, 'a dropdown of the cases while nothing is wired')
})

test('an enum input of an extension node carries its cases, and refuses a text', () => {
  const [format] = declaredHandlesOf({ type: CONVERT, data: {} }, handlesOfType, enums)
  assert.deepEqual(format.cases, CASES)
  assert.equal(takesEdge('c', [format], format, STRING_TYPE, []), false)
  const text: ExtensionHandle = { id: 'text', role: 'target', handleType: STRING_TYPE }
  assert.equal(takesEdge('f', [text], text, FORMAT, [], true), true, 'a text input takes the enum')
})

test("a Switch's refusal of a number names every enum among what it takes", () => {
  const [, condition] = valueNodeHandles('switch', {}, enums)
  assert.match(
    connectRefusal('s', [condition], condition, 'builtin.core.number', []) ?? '',
    /takes true\/false, a text or an enum \(builtin\.core\.boolean, builtin\.core\.string, every enum\), not builtin\.core\.number/,
  )
})

test('a Switch follows the enum fed into its condition when what feeds it changes', () => {
  const graph = {
    nodes: [
      { id: 'c', type: CONVERT, data: {} },
      { id: 's', type: 'builtin.core.switch', data: {} },
    ],
    edges: [{ id: 'e', source: 'c', sourceHandle: 'chosen', target: 's', targetHandle: 'condition' }],
  }
  const followed = withFollowedTypes(graph, handlesOfType, enums)
  assert.deepEqual(followed.nodes[1].data, { inputTypes: { condition: FORMAT } })
})

test("a typed value on a Switch's or a Select's input that is not a case of the enum it is on is a problem naming the cases", () => {
  const problems = (type: string, data: Record<string, unknown>) =>
    typedInputProblems(declaredHandlesOf({ type, data }, handlesOfType, enums), data).map((p) => [p.path, p.title])
  const onSwitch = { inputTypes: { condition: FORMAT }, inputs: { condition: 'webp' } }
  assert.deepEqual(problems('builtin.core.switch', onSwitch), [['inputs.condition', 'Must be one of: png, jpeg']])
  const onSelect = { inputTypes: { value: FORMAT }, inputs: { true: 'png', false: 'hello', condition: false } }
  assert.deepEqual(problems('builtin.core.select', onSelect), [['inputs.false', 'Must be one of: png, jpeg']])
  const onText = { inputTypes: { condition: STRING_TYPE }, inputs: { condition: 'hello' } }
  assert.deepEqual(problems('builtin.core.switch', onText), [], 'on a text the same value is fine')
})

test('connecting an enum into a Select that keeps a typed text introduces the problem, so a graph write refuses it', () => {
  const checked = (data: Record<string, unknown>) => ({
    data,
    problems: typedInputProblems(declaredHandlesOf({ type: 'builtin.core.select', data }, handlesOfType, enums), data),
  })
  const before = { inputTypes: { value: STRING_TYPE }, inputs: { false: 'hello' } }
  const [branch] = valueNodeHandles('select', before, enums).filter((h) => h.id === 'true')
  const after = dataOnConnect(before, branch, FORMAT, true)
  assert.deepEqual(
    introducedProblems(checked(before), checked(after)).map((p) => p.path),
    ['inputs.false'],
  )
})
