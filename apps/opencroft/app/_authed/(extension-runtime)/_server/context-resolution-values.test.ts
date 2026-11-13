// The server's context resolution evaluating a chain of core value nodes with
// their own exposeOutput, at the top level and inside a subgraph fed by the
// value typed on its input port.

import assert from 'node:assert/strict'
import test from 'node:test'

import { NO_ENUMS } from '@opencroft/core/values'
import type { ExposeOutput } from '@opencroft/server/actions'

import { portValueOf } from '../_builtin/core/src/nodes/subgraph-shared'
import {
  bareValueNodeType,
  VALUE_NODE,
  valueNodeExposed,
  valueNodeOutput,
} from '../_builtin/core/src/nodes/value-nodes-shared'
import { type ContextResolverDeps, resolveContexts } from './context-resolution'
import type { GraphNodeRecord, GraphSnapshot } from './host'

// As core's server module answers a value node's output, with the enums the resolver hands it.
const exposeOutput: ExposeOutput = (handleId, data, type, _nodeId, _run, enumCasesOf = NO_ENUMS) => {
  const valueNode = bareValueNodeType(type)
  if (valueNode) {
    return valueNodeExposed(valueNode, handleId, data, enumCasesOf)
  }
  return type === 'subgraph' ? portValueOf(data, handleId) : undefined
}

const CORE_TYPES = [...Object.values(VALUE_NODE), 'subgraph'].map((bare) => `builtin.core.${bare}`)

const deps: ContextResolverDeps = {
  nodeTypeToExtension: new Map(CORE_TYPES.map((type) => [type, { extensionId: 'builtin.core', handles: [] }])),
  exposeOutputOf: async () => exposeOutput,
  enumCasesOf: NO_ENUMS,
  resolveTerminalTarget: async () => null,
}

function node(id: string, bare: string, data: Record<string, unknown>, parentId?: string): GraphNodeRecord {
  return { id, type: `builtin.core.${bare}`, data, ...(parentId ? { parentId } : {}) } as GraphNodeRecord
}

const edge = (id: string, source: string, target: string) => {
  const [s, sh] = source.split('/')
  const [t, th] = target.split('/')
  return { id, source: s, sourceHandle: sh, target: t, targetHandle: th }
}

function formatted(graph: GraphSnapshot): unknown {
  const format = graph.nodes.find((n) => n.id === 'f')
  return valueNodeOutput(VALUE_NODE.format, 'text', format?.data ?? {}, NO_ENUMS)
}

test('a Format fed by a Text and a Math Expression formats what they compute', async () => {
  const graph: GraphSnapshot = {
    nodes: [
      node('t', VALUE_NODE.value, { value: 'cat' }),
      node('m', VALUE_NODE.mathExpression, { expression: 'a * 2 + 1', inputs: { 'var-a': 3 } }),
      node('f', VALUE_NODE.format, { template: '{name}_{n:03}.png' }),
    ],
    // The Format's edges first: a source read before its own inputs is read again.
    edges: [edge('e1', 'm/result', 'f/arg-n'), edge('e2', 't/value', 'f/arg-name')],
  }
  assert.deepEqual(formatted(await resolveContexts(graph, deps)), { ok: true, value: 'cat_007.png' })
})

test('a Math Expression with an error exposes nothing, so what it feeds reads nothing', async () => {
  const graph: GraphSnapshot = {
    nodes: [
      node('m', VALUE_NODE.mathExpression, { expression: 'a / 0', inputs: { 'var-a': 3 } }),
      node('f', VALUE_NODE.format, { template: '{n}', inputs: { 'arg-n': 'typed' } }),
    ],
    edges: [edge('e1', 'm/result', 'f/arg-n')],
  }
  const resolved = await resolveContexts(graph, deps)
  assert.deepEqual(resolved.nodes.find((n) => n.id === 'f')?.data.__unresolvedInputs, ['arg-n'])
  assert.deepEqual(formatted(resolved), { ok: false, error: 'Nothing to put in {n}' })
})

test('a Select on an enum hands what it feeds the case it picks, and nothing for a typed value that is no case', async () => {
  const FORMAT = 'acme.images.format'
  const enums = (type: string) => (type === FORMAT ? [{ value: 'png' }, { value: 'jpeg' }] : undefined)
  const graph = (condition: boolean): GraphSnapshot => ({
    nodes: [
      node('s', VALUE_NODE.select, {
        inputTypes: { value: FORMAT },
        inputs: { true: 'png', false: 'hello', condition },
      }),
      node('f', VALUE_NODE.format, { template: 'image.{ext}' }),
    ],
    edges: [edge('e1', 's/value', 'f/arg-ext')],
  })
  const withEnums = { ...deps, enumCasesOf: enums }
  assert.deepEqual(formatted(await resolveContexts(graph(true), withEnums)), { ok: true, value: 'image.png' })
  const stale = await resolveContexts(graph(false), withEnums)
  assert.deepEqual(stale.nodes.find((n) => n.id === 'f')?.data.__unresolvedInputs, ['arg-ext'])
})

test("inside a subgraph, the value typed on its input port wins over the inner node's own", async () => {
  const ports = { inputs: [{ id: 'a', label: 'a', handleType: 'builtin.core.number' }], outputs: [] }
  const graph: GraphSnapshot = {
    nodes: [
      node('s', 'subgraph', { name: 's', ports, inputs: { 'in-a': 3 } }),
      node('t', VALUE_NODE.value, { value: 'cat' }, 's'),
      node('m', VALUE_NODE.mathExpression, { expression: 'a * 2 + 1', inputs: { 'var-a': 10 } }, 's'),
      node('f', VALUE_NODE.format, { template: '{name}_{n:03}.png' }, 's'),
    ],
    edges: [edge('e0', 's/in-a', 'm/var-a'), edge('e1', 'm/result', 'f/arg-n'), edge('e2', 't/value', 'f/arg-name')],
  }
  assert.deepEqual(formatted(await resolveContexts(graph, deps)), { ok: true, value: 'cat_007.png' })
})
