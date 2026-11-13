// The server's context resolution of run-time outputs: outside a run they
// expose nothing and what they feed is listed as awaiting a run, down through
// the value nodes; inside one they carry the run's event.

import assert from 'node:assert/strict'
import test from 'node:test'

import { NO_ENUMS } from '@opencroft/core/values'
import type { ExposeOutput } from '@opencroft/server/actions'

import { RUN_OUTPUTS, runOutputValue } from '../_builtin/core/src/nodes/run-outputs'
import { bareValueNodeType, VALUE_NODE, valueNodeExposed } from '../_builtin/core/src/nodes/value-nodes-shared'
import { type ContextResolverDeps, resolveContexts } from './context-resolution'
import type { GraphNodeRecord, GraphSnapshot } from './host'

const exposeOutput: ExposeOutput = (handleId, data, type, _nodeId, run) => {
  if (Object.hasOwn(RUN_OUTPUTS, type)) {
    return runOutputValue(type, handleId, run)
  }
  const valueNode = bareValueNodeType(type)
  return valueNode ? valueNodeExposed(valueNode, handleId, data, NO_ENUMS) : undefined
}

const ROUTE_HANDLES = RUN_OUTPUTS['api-route'].map((h) => ({ ...h, handleType: `builtin.core.${h.handleType}` }))

function deps(runEvents?: Record<string, unknown>): ContextResolverDeps {
  const types = [...Object.values(VALUE_NODE), 'api-route'].map((bare) => `builtin.core.${bare}`)
  return {
    nodeTypeToExtension: new Map(
      types.map((type) => [
        type,
        { extensionId: 'builtin.core', handles: type === 'builtin.core.api-route' ? ROUTE_HANDLES : [] },
      ]),
    ),
    exposeOutputOf: async () => exposeOutput,
    enumCasesOf: NO_ENUMS,
    resolveTerminalTarget: async () => null,
    ...(runEvents ? { runEventOf: (nodeId: string) => runEvents[nodeId] } : {}),
  }
}

function node(id: string, bare: string, data: Record<string, unknown>): GraphNodeRecord {
  return { id, type: `builtin.core.${bare}`, data } as GraphNodeRecord
}

const edge = (id: string, source: string, target: string) => {
  const [s, sh] = source.split('/')
  const [t, th] = target.split('/')
  return { id, source: s, sourceHandle: sh, target: t, targetHandle: th }
}

// Route body -> Get `user.age` (number) -> Math Expression `a >= 18`, and a
// Math Expression fed by a Text that does not parse as a control.
const graph: GraphSnapshot = {
  nodes: [
    node('route', 'api-route', { path: '/age', methods: ['POST'] }),
    node('get', VALUE_NODE.get, { valueType: 'builtin.core.number', inputs: { path: 'user.age' } }),
    node('math', VALUE_NODE.mathExpression, { expression: 'a >= 18' }),
    node('bad', VALUE_NODE.mathExpression, { expression: 'a +' }),
    node('after-bad', VALUE_NODE.mathExpression, { expression: 'b * 2' }),
  ],
  edges: [
    edge('e1', 'route/body', 'get/object'),
    edge('e2', 'get/value', 'math/var-a'),
    edge('e3', 'bad/result', 'after-bad/var-b'),
  ],
}

const dataOf = (resolved: GraphSnapshot, id: string) => resolved.nodes.find((n) => n.id === id)?.data ?? {}

test('outside a run, what a run-time output feeds awaits a run, down through the value nodes', async () => {
  const resolved = await resolveContexts(graph, deps())
  assert.deepEqual(dataOf(resolved, 'get').__awaitingRun, ['object'])
  assert.deepEqual(dataOf(resolved, 'get').__unresolvedInputs, ['object'])
  assert.deepEqual(dataOf(resolved, 'math').__awaitingRun, ['var-a'])
  // A source with an error of its own leaves what it feeds unresolved, not awaiting.
  assert.deepEqual(dataOf(resolved, 'after-bad').__unresolvedInputs, ['var-b'])
  assert.equal(dataOf(resolved, 'after-bad').__awaitingRun, undefined)
})

test("inside a run, the route's body flows to the value nodes", async () => {
  const resolved = await resolveContexts(graph, deps({ route: { body: { user: { age: 30 } } } }))
  assert.equal(dataOf(resolved, 'get').__awaitingRun, undefined)
  assert.equal(valueNodeExposed(VALUE_NODE.mathExpression, 'result', dataOf(resolved, 'math'), NO_ENUMS), true)
})

test("a run of another node leaves this route's outputs awaiting theirs", async () => {
  const resolved = await resolveContexts(graph, deps({ other: { body: { user: { age: 30 } } } }))
  assert.deepEqual(dataOf(resolved, 'get').__awaitingRun, ['object'])
})

test('in a run whose body has no object, what it feeds is unresolved, not awaiting', async () => {
  const resolved = await resolveContexts(graph, deps({ route: { body: 'plain' } }))
  assert.deepEqual(dataOf(resolved, 'get').__unresolvedInputs, ['object'])
  assert.equal(dataOf(resolved, 'get').__awaitingRun, undefined)
})

test('a stored awaiting list is recomputed, not carried over', async () => {
  const stale: GraphSnapshot = {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === 'bad' ? { ...n, data: { ...n.data, __awaitingRun: ['x'] } } : n)),
  }
  const resolved = await resolveContexts(stale, deps())
  assert.equal(dataOf(resolved, 'bad').__awaitingRun, undefined)
})
