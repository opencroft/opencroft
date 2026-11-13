import assert from 'node:assert/strict'
import test from 'node:test'

import { BOOLEAN_TYPE, NO_ENUMS, NUMBER_TYPE, STRING_TYPE } from '@opencroft/core/values'

import { withReplacedValueNodes } from './replaced-value-nodes'
import { VALUE_NODE, valueNodeExposed, valueNodeHandles } from './value-nodes-shared'

const at = { x: 40, y: 80 }

test('Text, Number and Boolean become a Value of their type, keeping id, place and value', () => {
  const graph = {
    nodes: [
      { id: 't', type: 'builtin.core.text-value', position: at, data: { value: 'cat' } },
      { id: 'n', type: 'builtin.core.number-value', position: at, parentId: 'frame', data: { value: 3 } },
      { id: 'b', type: 'builtin.core.boolean-value', position: at, data: { value: true } },
    ],
    edges: [{ id: 'e', source: 't', sourceHandle: 'value', target: 'f', targetHandle: 'arg-name' }],
  }
  const { nodes, edges } = withReplacedValueNodes(graph)
  assert.deepEqual(nodes, [
    { id: 't', type: 'builtin.core.value', position: at, data: { value: 'cat', valueType: STRING_TYPE } },
    {
      id: 'n',
      type: 'builtin.core.value',
      position: at,
      parentId: 'frame',
      data: { value: 3, valueType: NUMBER_TYPE },
    },
    { id: 'b', type: 'builtin.core.value', position: at, data: { value: true, valueType: BOOLEAN_TYPE } },
  ])
  assert.equal(edges[0], graph.edges[0], 'a Value’s output keeps its id')
})

test('To Number and To Boolean become a Convert, and their edges and typed text move onto its handles', () => {
  const graph = {
    nodes: [
      {
        id: 'tn',
        type: 'builtin.core.to-number',
        position: at,
        data: { inputs: { text: '42' }, __resolvedContexts: { text: {} }, __unresolvedInputs: ['text'] },
      },
      { id: 'tb', type: 'builtin.core.to-boolean', position: at, data: {} },
    ],
    edges: [
      { id: 'in', source: 's', sourceHandle: 'value', target: 'tn', targetHandle: 'text' },
      { id: 'out', source: 'tn', sourceHandle: 'number', target: 'm', targetHandle: 'var-a' },
      { id: 'in2', source: 's', sourceHandle: 'value', target: 'tb', targetHandle: 'value' },
      { id: 'out2', source: 'tb', sourceHandle: 'boolean', target: 'sel', targetHandle: 'condition' },
    ],
  }
  const { nodes, edges } = withReplacedValueNodes(graph)
  assert.deepEqual(nodes, [
    { id: 'tn', type: 'builtin.core.convert', position: at, data: { inputs: { value: '42' }, valueType: NUMBER_TYPE } },
    { id: 'tb', type: 'builtin.core.convert', position: at, data: { valueType: BOOLEAN_TYPE } },
  ])
  assert.deepEqual(
    edges.map((e) => `${e.id}: ${e.source}/${e.sourceHandle} -> ${e.target}/${e.targetHandle}`),
    [
      'in: s/value -> tn/value',
      'out: tn/value -> m/var-a',
      'in2: s/value -> tb/value',
      'out2: tb/value -> sel/condition',
    ],
  )
  assert.equal(valueNodeExposed(VALUE_NODE.convert, 'value', nodes[0].data, NO_ENUMS), 42, 'the typed text converts')
  const handles = valueNodeHandles(VALUE_NODE.convert, nodes[0].data, NO_ENUMS).map((h) => `${h.role}:${h.id}`)
  assert.deepEqual(handles, ['target:value', 'source:value'], 'every moved edge lands on a handle the node has')
})

test('a graph with none of the replaced nodes is returned as it is', () => {
  const graph = {
    nodes: [{ id: 'f', type: 'builtin.core.format', data: { template: '{a}' } }],
    edges: [{ id: 'e', source: 'x', sourceHandle: 'text', target: 'f', targetHandle: 'arg-a' }],
  }
  assert.equal(withReplacedValueNodes(graph), graph)
})
