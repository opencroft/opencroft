import assert from 'node:assert/strict'
import test from 'node:test'

import { BOOLEAN_TYPE, NO_ENUMS, NUMBER_TYPE, STRING_TYPE } from '@opencroft/core/values'

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { valueNodeHandles } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/value-nodes-shared'
import { connectRefusal, dataOnConnect, withFollowedTypes } from '@/app/_authed/(extension-runtime)/_input-types'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

const core = (bare: string) => `builtin.core.${bare}`
const noTypes = () => [] as ExtensionHandle[]

interface TestNode {
  id: string
  type: string
  data?: Record<string, unknown>
  parentId?: string
}

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({
  id: `${source}/${sourceHandle}>${target}/${targetHandle}`,
  source,
  sourceHandle,
  target,
  targetHandle,
})

const dataOf = (graph: { nodes: readonly TestNode[] }, id: string) => graph.nodes.find((n) => n.id === id)?.data

test("connecting sets the group's type of an input that takes several types, and leaves other inputs' data alone", () => {
  const [, condition] = valueNodeHandles('switch', {}, NO_ENUMS)
  assert.deepEqual(dataOnConnect({ cases: [] }, condition, STRING_TYPE), {
    cases: [],
    inputTypes: { condition: STRING_TYPE },
  })
  const data = { inputTypes: { condition: STRING_TYPE } }
  assert.equal(dataOnConnect(data, condition, STRING_TYPE), data, 'that type already')
  assert.equal(dataOnConnect(data, condition, NUMBER_TYPE), data, 'a type it does not take')
  const [, branch] = valueNodeHandles('select', {}, NO_ENUMS)
  assert.deepEqual(dataOnConnect({}, branch, NUMBER_TYPE), { inputTypes: { value: NUMBER_TYPE } })
  const one = { id: 'on', role: 'target' as const, handleType: BOOLEAN_TYPE }
  assert.equal(dataOnConnect(data, one, BOOLEAN_TYPE), data)
})

test('an object connected into Select’s True makes True, False and Value objects, wired only', () => {
  const OBJECT = core('object')
  const [, branch] = valueNodeHandles('select', {}, NO_ENUMS)
  const data = dataOnConnect({}, branch, OBJECT)
  assert.deepEqual(data, { inputTypes: { value: OBJECT } })
  const [, whenTrue, whenFalse, value] = valueNodeHandles('select', data, NO_ENUMS)
  assert.deepEqual(
    [whenTrue, whenFalse, value].map((h) => h.handleType),
    [OBJECT, OBJECT, OBJECT],
  )
  assert.equal(whenTrue.inline, false, 'an object input takes no typed value')
  assert.equal(connectRefusal('sel', [whenTrue], whenTrue, OBJECT, []), null)
})

test('the refusal names what an input takes, or the input of its group that is wired', () => {
  const handles = valueNodeHandles('select', { inputTypes: { value: NUMBER_TYPE } }, NO_ENUMS)
  const falseInput = handles.find((h) => h.id === 'false') as ExtensionHandle
  const wired = [{ target: 'sel', targetHandle: 'true' }]
  assert.equal(
    connectRefusal('sel', handles, falseInput, STRING_TYPE, wired),
    `False shares one type with the inputs of its group, and True is wired from ${NUMBER_TYPE}: it takes ${NUMBER_TYPE} only, not ${STRING_TYPE}.`,
  )
  assert.equal(connectRefusal('sel', handles, falseInput, NUMBER_TYPE, wired), null)
  const [, condition] = valueNodeHandles('switch', {}, NO_ENUMS)
  assert.equal(
    connectRefusal('sw', [condition], condition, NUMBER_TYPE, []),
    `Condition takes true/false, a text or an enum (${BOOLEAN_TYPE}, ${STRING_TYPE}, every enum), not ${NUMBER_TYPE}.`,
  )
})

test("an input follows its source's type when that type changes, and what reads it follows in turn", () => {
  const graph = {
    nodes: [
      { id: 'm', type: core('math-expression'), data: { expression: 'a > 1' } },
      { id: 'sel', type: core('select'), data: { inputTypes: { value: NUMBER_TYPE } } },
      { id: 'sw', type: core('switch'), data: {} },
      { id: 'sel2', type: core('select'), data: {} },
    ] as TestNode[],
    edges: [edge('m', 'result', 'sel', 'true'), edge('sel', 'value', 'sel2', 'false')],
  }
  const followed = withFollowedTypes(graph, noTypes, NO_ENUMS)
  assert.deepEqual(dataOf(followed, 'sel'), { inputTypes: { value: BOOLEAN_TYPE } })
  assert.deepEqual(dataOf(followed, 'sel2'), { inputTypes: { value: BOOLEAN_TYPE } }, 'downstream, in one call')
  assert.equal(followed.nodes[2], graph.nodes[2], 'a node nothing feeds is kept')
  assert.equal(withFollowedTypes(followed, noTypes, NO_ENUMS), followed, 'nothing left to change')
})

test('a Math Expression variable that == alone decides follows a Boolean, and its result types what it feeds', () => {
  const graph = {
    nodes: [
      { id: 'flag', type: core('value'), data: { valueType: 'builtin.core.boolean', value: true } },
      { id: 'm', type: core('math-expression'), data: { expression: 'a == b' } },
      { id: 'choice', type: core('math-expression'), data: { expression: 'c ? x : y' } },
      { id: 'sel', type: core('select'), data: {} },
    ] as TestNode[],
    edges: [
      edge('flag', 'value', 'm', 'var-a'),
      edge('flag', 'value', 'choice', 'var-x'),
      edge('choice', 'result', 'sel', 'true'),
    ],
  }
  const followed = withFollowedTypes(graph, noTypes, NO_ENUMS)
  assert.deepEqual(dataOf(followed, 'm'), { expression: 'a == b', inputTypes: { 'var-a': BOOLEAN_TYPE } })
  const [, b] = valueNodeHandles('math-expression', dataOf(followed, 'm') ?? {}, NO_ENUMS)
  assert.equal(b.handleType, BOOLEAN_TYPE, 'b shares the type of a')
  assert.deepEqual(dataOf(followed, 'sel'), { inputTypes: { value: BOOLEAN_TYPE } }, "the result has x's type")
  const handles = valueNodeHandles('math-expression', dataOf(followed, 'm') ?? {}, NO_ENUMS)
  assert.equal(
    connectRefusal('m', handles, b, NUMBER_TYPE, [{ target: 'm', targetHandle: 'var-a' }]),
    `b shares one type with the inputs of its group, and a is wired from ${BOOLEAN_TYPE}: it takes ${BOOLEAN_TYPE} only, not ${NUMBER_TYPE}.`,
  )
  assert.equal(
    connectRefusal('m', handles, b, STRING_TYPE, []),
    `b takes a number or true/false (${NUMBER_TYPE}, ${BOOLEAN_TYPE}), not ${STRING_TYPE}.`,
  )
})

test('a group whose wired inputs are fed two types keeps its type, and follows once they agree', () => {
  const graph = {
    nodes: [
      { id: 'mt', type: core('math-expression'), data: { expression: 'a > 1' } },
      { id: 'mf', type: core('math-expression'), data: { expression: 'b + 1' } },
      { id: 'sel', type: core('select'), data: { inputTypes: { value: NUMBER_TYPE } } },
      { id: 'mc', type: core('math-expression'), data: { expression: 'c > 1' } },
      { id: 'sw', type: core('switch'), data: { inputTypes: { condition: STRING_TYPE } } },
    ] as TestNode[],
    // The retyped source comes last, where a walk edge by edge would leave its type.
    edges: [
      edge('mf', 'result', 'sel', 'false'),
      edge('mt', 'result', 'sel', 'true'),
      edge('mc', 'result', 'sw', 'condition'),
    ],
  }
  const followed = withFollowedTypes(graph, noTypes, NO_ENUMS)
  assert.deepEqual(dataOf(followed, 'sw'), { inputTypes: { condition: BOOLEAN_TYPE } }, 'another node still follows')
  assert.equal(followed.nodes[2], graph.nodes[2], 'the Select keeps its type')
  assert.equal(withFollowedTypes(followed, noTypes, NO_ENUMS), followed, 'nothing left to change')

  const agreeing = {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === 'mf' ? { ...n, data: { expression: 'b > 1' } } : n)),
  }
  assert.deepEqual(dataOf(withFollowedTypes(agreeing, noTypes, NO_ENUMS), 'sel'), {
    inputTypes: { value: BOOLEAN_TYPE },
  })
})

test('an input fed a type it does not take keeps its type', () => {
  const graph = {
    nodes: [
      { id: 'n', type: core('value'), data: { valueType: 'builtin.core.number', value: 3 } },
      { id: 'sw', type: core('switch'), data: { inputTypes: { condition: STRING_TYPE } } },
    ] as TestNode[],
    edges: [edge('n', 'value', 'sw', 'condition')],
  }
  assert.equal(withFollowedTypes(graph, noTypes, NO_ENUMS), graph)
})

test('inside a subgraph, an inner input follows what is wired outside, and the port takes that type on the card', () => {
  const port = { id: 'p', label: 'Condition', handleType: BOOLEAN_TYPE, accepts: [BOOLEAN_TYPE, STRING_TYPE] }
  const graph = {
    nodes: [
      { id: 't', type: core('value'), data: { value: 'draft' } },
      { id: 's', type: SUBGRAPH_TYPE, data: { name: 'S', ports: { inputs: [port], outputs: [] } } },
      { id: 'sw', type: core('switch'), data: {}, parentId: 's' },
    ] as TestNode[],
    edges: [edge('t', 'value', 's', 'in-p'), edge('s', 'in-p', 'sw', 'condition')],
  }
  const followed = withFollowedTypes(graph, noTypes, NO_ENUMS)
  assert.deepEqual(dataOf(followed, 'sw'), { inputTypes: { condition: STRING_TYPE } })
  assert.deepEqual(dataOf(followed, 's')?.inputTypes, { 'in-p': STRING_TYPE })
})

test('an output port of a value type takes the type of the inner source feeding it', () => {
  const graph = {
    nodes: [
      {
        id: 's',
        type: SUBGRAPH_TYPE,
        data: { name: 'S', ports: { inputs: [], outputs: [{ id: 'o', label: 'Result', handleType: NUMBER_TYPE }] } },
      },
      { id: 'm', type: core('math-expression'), data: { expression: 'a > 1' }, parentId: 's' },
    ] as TestNode[],
    edges: [edge('m', 'result', 's', 'out-o')],
  }
  const ports = dataOf(withFollowedTypes(graph, noTypes, NO_ENUMS), 's')?.ports as { outputs: { handleType: string }[] }
  assert.equal(ports.outputs[0].handleType, BOOLEAN_TYPE)
})

test("an extension's input that declares accepts follows like a core one", () => {
  const declared: ExtensionHandle[] = [
    { id: 'level', role: 'target', handleType: NUMBER_TYPE, accepts: [NUMBER_TYPE, STRING_TYPE] },
  ]
  const graph = {
    nodes: [
      { id: 't', type: core('value'), data: { value: 'high' } },
      { id: 'g', type: 'acme.widgets.gauge', data: {} },
    ] as TestNode[],
    edges: [edge('t', 'value', 'g', 'level')],
  }
  const followed = withFollowedTypes(graph, (type) => (type === 'acme.widgets.gauge' ? declared : []), NO_ENUMS)
  assert.deepEqual(dataOf(followed, 'g'), { inputTypes: { level: STRING_TYPE } })
})
